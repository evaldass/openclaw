import { createHash } from "node:crypto";
import {
  AccessToken,
  WebhookEvent,
  WebhookReceiver,
  Room,
  ParticipantInfo,
  SIPParticipantInfo,
  ServerError,
} from "livekit-server-sdk";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, validateProviderConfig } from "../config.js";
import { CallManager } from "../manager.js";
import {
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
  registerTestManagerCleanup,
} from "../manager.test-harness.js";
import type { CallRecord, WebhookContext } from "../types.js";
import { RealtimeCallHandler } from "../webhook/realtime-handler.js";
import {
  createBridge,
  makeRealtimeProvider,
} from "../webhook/realtime-handler.lifecycle.test-helpers.js";
import { LiveKitProvider, type LiveKitDependencies } from "./livekit.js";

// Offline state boundary: exercise the real manager admission/identity owner without
// requiring a host SQLite broker inside Vitest's application worker.
vi.mock("../manager/store.js", () => {
  const records = new Map<string, Map<string, CallRecord>>();
  const store = (path: string) => {
    let values = records.get(path);
    if (!values) {
      values = new Map();
      records.set(path, values);
    }
    return values;
  };
  return {
    persistCallRecord: async (path: string, call: CallRecord) => {
      store(path).set(call.callId, structuredClone(call));
    },
    findCallInStore: async (path: string, id: string) =>
      [...store(path).values()].find((call) => call.callId === id || call.providerCallId === id),
    loadActiveCallsFromStore: async () => ({
      activeCalls: new Map(),
      processedEventIds: new Set(),
    }),
    getCallHistoryFromStore: async (path: string) => [...store(path).values()],
  };
});

const livekit = {
  url: "wss://livekit.example.test",
  apiKey: "test-key",
  apiSecret: "synthetic-livekit-secret-for-offline-tests",
  outboundTrunkId: "ST_out",
  inboundTrunkIds: ["ST_in"],
  roomPrefix: "openclaw-call-",
};
const from = "+15550000001";
const to = "+15550000002";

function webhook(
  room: string,
  event = "participant_joined",
  id = "event-1",
  overrides: Record<string, unknown> = {},
) {
  return WebhookEvent.fromJsonString(
    JSON.stringify({
      id,
      event,
      createdAt: String(Math.floor(Date.now() / 1000)),
      room: { name: room },
      participant: {
        identity: "sip-inbound",
        sid: "PA_in",
        kind: "SIP",
        attributes: { "sip.trunkID": "ST_in", "sip.phoneNumber": from, "sip.trunkPhoneNumber": to },
        ...overrides,
      },
    }),
  );
}
function context(event: WebhookEvent): WebhookContext {
  return {
    headers: { authorization: "synthetic-authorization" },
    rawBody: event.toJsonString(),
    method: "POST",
    url: "https://voice.example.test/webhook",
  };
}

async function harness(policy: "open" | "allowlist" = "open") {
  let participants: Array<{ identity: string; sid: string; kind: number }> = [
    { identity: "sip-inbound", sid: "PA_in", kind: 3 },
  ];
  const close = vi.fn(async () => {});
  const connectAudio = vi.fn<LiveKitDependencies["connectAudio"]>(async () => ({ close }));
  const rooms = {
    createRoom: vi.fn<LiveKitDependencies["rooms"]["createRoom"]>(async () => new Room()),
    deleteRoom: vi.fn(async () => {}),
    listRooms: vi.fn<LiveKitDependencies["rooms"]["listRooms"]>(async (names) =>
      names!.map((name) => new Room({ name, maxParticipants: 2 })),
    ),
    listParticipants: vi.fn<LiveKitDependencies["rooms"]["listParticipants"]>(async () =>
      participants.map((participant) => new ParticipantInfo(participant)),
    ),
  };
  const sip = {
    createSipParticipant: vi.fn<LiveKitDependencies["sip"]["createSipParticipant"]>(
      async (_trunk, _number, _room, opts) => {
        participants = [{ identity: opts!.participantIdentity!, sid: "PA_out", kind: 3 }];
        return new SIPParticipantInfo({ participantId: "PA_out" });
      },
    ),
  };
  const receiver = {
    receive: vi.fn<LiveKitDependencies["receiver"]["receive"]>(async (body) =>
      WebhookEvent.fromJsonString(body),
    ),
  };
  const provider = new LiveKitProvider(livekit, { rooms, sip, receiver, connectAudio });
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    agentId: "main",
    provider: "livekit",
    livekit,
    fromNumber: from,
    inboundPolicy: policy,
    allowFrom: [],
    realtime: { enabled: true },
    outbound: { defaultMode: "conversation" },
  });
  installVoiceCallStateRuntimeForTests();
  const manager = registerTestManagerCleanup(new CallManager(config, createTestStorePath()));
  await manager.initialize(provider, "https://voice.example.test/webhook");
  const bridge = createBridge(
    vi.fn(async () => {}),
    { sendAudio: vi.fn() },
  );
  const createModelBridge = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() => bridge);
  const realtime = makeRealtimeProvider(createModelBridge);
  const handler = new RealtimeCallHandler(
    config.realtime,
    manager,
    () => ({
      agentId: "main",
      provider: realtime,
      providerConfig: {},
      instructions: "Test",
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ],
        handlesAgentConsult: true,
      },
    }),
    config.serve.path,
    { connect() {}, disconnect() {}, retire() {} },
  );
  provider.bind(manager, handler);
  const receive = async (event: WebhookEvent) => {
    const ctx = context(event);
    expect((await provider.verifyWebhook(ctx)).ok).toBe(true);
    const result = provider.parseWebhookEvent(ctx);
    for (const normalized of result.events) await manager.processEvent(normalized);
    const call = manager.getCallByProviderCallId(event.room!.name);
    if (call && result.events.some((item) => item.type === "call.initiated"))
      await provider.answerCall({ callId: call.callId, providerCallId: event.room!.name });
    return result;
  };
  return {
    bridge,
    createModelBridge,
    provider,
    manager,
    handler,
    rooms,
    sip,
    connectAudio,
    close,
    receiver,
    receive,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("LiveKit telephony lifecycle", () => {
  it("attaches RTC to the existing realtime owner with call-bound native agent delegation", async () => {
    const h = await harness();
    const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    const call = h.manager.getCall(started.callId)!;
    const consult = vi.fn(async () => ({ text: "Call-owned agent answer" }));
    h.handler.registerToolHandler(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, consult);
    let open = true;
    const transport = {
      get readyState() {
        return open ? 1 : 3;
      },
      bufferedAmount: 0,
      send: vi.fn(),
      close: () => {
        open = false;
      },
    };
    const binding = await h.handler.attachRoomTransport({
      callId: call.callId,
      providerCallId: call.providerCallId!,
      streamId: "rtc-test",
      transport,
    });
    expect(binding).not.toBeNull();
    binding!.sendAudio(Buffer.from([255, 255, 255]));
    expect(h.bridge.sendAudio).toHaveBeenCalledWith(Buffer.from([255, 255, 255]));
    const options = h.createModelBridge.mock.calls[0]![0];
    expect(options.runAgentConsult).toBeTypeOf("function");
    await expect(
      options.runAgentConsult!({ prompt: "Check the caller's request" }),
    ).resolves.toEqual({ text: "Call-owned agent answer" });
    expect(consult).toHaveBeenCalledWith(expect.anything(), call.callId, expect.anything());
    await h.manager.endCall(call.callId);
    binding!.endCall();
    await h.handler.close();
    await h.provider.stop();
    expect(h.bridge.close).toHaveBeenCalled();
  });

  it("distinguishes missing rooms from transient status failures and shuts down active calls", async () => {
    const h = await harness();
    await expect(
      h.provider.hangupCall({
        callId: "foreign",
        providerCallId: "shared-room",
        reason: "completed",
      }),
    ).rejects.toThrow("outside the configured room prefix");
    expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
    h.rooms.listParticipants.mockRejectedValueOnce(
      new ServerError("not_found", "synthetic missing room", 404, "not_found"),
    );
    await expect(
      h.provider.getCallStatus({ providerCallId: "openclaw-call-missing" }),
    ).resolves.toEqual({ status: "completed", isTerminal: true });
    h.rooms.listParticipants.mockRejectedValueOnce(new Error("synthetic transient"));
    expect(
      (await h.provider.getCallStatus({ providerCallId: "openclaw-call-transient" })).isUnknown,
    ).toBe(true);
    const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    expect(started.success).toBe(true);
    const stopping = h.provider.stop();
    expect(h.provider.stop()).toBe(stopping);
    await stopping;
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    expect(h.close).toHaveBeenCalledOnce();
    await h.handler.close();
  });

  it("selects the outbound trunk and correlates an isolated room before RTC join", async () => {
    const h = await harness();
    const result = await h.manager.initiateCall(to, undefined, {
      mode: "conversation",
      message: "Hello",
    });
    expect(result.success).toBe(true);
    const call = h.manager.getCall(result.callId)!;
    expect(call.providerCallId).toMatch(/^openclaw-call-/);
    expect(h.sip.createSipParticipant).toHaveBeenCalledWith(
      "ST_out",
      to,
      call.providerCallId,
      expect.objectContaining({ fromNumber: from, waitUntilAnswered: true }),
    );
    expect(h.connectAudio).toHaveBeenCalledOnce();
    expect(h.connectAudio.mock.calls[0]![0]).toMatchObject({
      room: call.providerCallId,
      callId: result.callId,
      participantSid: "PA_out",
    });
    await h.manager.endCall(result.callId);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith(call.providerCallId);
    await h.provider.stop();
    await h.handler.close();
  });

  it("admits a signed selected inbound trunk once and ignores duplicate/foreign participants", async () => {
    const h = await harness();
    const room = "openclaw-call-inbound";
    await h.receive(webhook(room));
    expect(h.connectAudio).toHaveBeenCalledOnce();
    await h.receive(webhook(room));
    await h.receive(
      webhook(room, "participant_left", "other-left", { identity: "foreign", sid: "PA_other" }),
    );
    expect(h.connectAudio).toHaveBeenCalledOnce();
    expect(h.manager.getActiveCalls()).toHaveLength(1);
    await h.receive(webhook(room, "participant_left", "caller-left"));
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.receive(webhook(room, "participant_joined", "late-join"));
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    expect(h.connectAudio).toHaveBeenCalledOnce();
    await h.provider.stop();
    await h.handler.close();
  });

  it("enforces existing caller allowlist before any token or RTC session", async () => {
    const h = await harness("allowlist");
    await h.receive(webhook("openclaw-call-rejected"));
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith("openclaw-call-rejected");
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("ignores unselected trunks, non-SIP callers, and unverified bodies", async () => {
    const h = await harness();
    const event = webhook("openclaw-call-foreign", "participant_joined", "foreign", {
      attributes: {
        "sip.trunkID": "ST_wrong",
        "sip.phoneNumber": from,
        "sip.trunkPhoneNumber": to,
      },
    });
    expect(h.provider.parseWebhookEvent(context(event)).events).toEqual([]);
    await h.receive(event);
    await h.receive(
      webhook("openclaw-call-human", "participant_joined", "human", { kind: "STANDARD" }),
    );
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("requires a server-enforced two-participant room cap before publishing speech", async () => {
    const h = await harness();
    h.rooms.listRooms.mockResolvedValue([
      new Room({ name: "openclaw-call-unbounded", maxParticipants: 0 }),
    ]);
    await h.receive(webhook("openclaw-call-unbounded"));
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("fails closed when another participant is present and cleans up setup failures", async () => {
    const h = await harness();
    h.rooms.listParticipants.mockResolvedValue([
      new ParticipantInfo({ identity: "sip-inbound", sid: "PA_in" }),
      new ParticipantInfo({ identity: "foreign" }),
    ]);
    await h.receive(webhook("openclaw-call-shared"));
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith("openclaw-call-shared");
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("cancels a pending dial without joining and removes a late-created SIP participant", async () => {
    const h = await harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const dialing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.sip.createSipParticipant.mockImplementation(async () => {
      entered();
      await held;
      return new SIPParticipantInfo({ participantId: "PA_late" });
    });
    const initiated = h.manager.initiateCall(to, undefined, { mode: "conversation" });
    await dialing;
    const call = h.manager.getActiveCalls()[0]!;
    await h.manager.endCall(call.callId);
    release();
    expect((await initiated).success).toBe(false);
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.rooms.deleteRoom.mock.calls.length).toBeGreaterThanOrEqual(2);
    await h.provider.stop();
    await h.handler.close();
  });
});

it("uses SDK signature and body digest verification, expiring room-scoped microphone-only grants", async () => {
  const provider = new LiveKitProvider(livekit);
  const room = "openclaw-call-security";
  const jwt = await provider.roomToken(room);
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  expect(claims.video).toMatchObject({
    room,
    roomJoin: true,
    canPublishData: false,
    canPublishSources: ["microphone"],
  });
  expect(claims.video.roomAdmin).toBeUndefined();
  expect(claims.sip).toBeUndefined();
  expect(claims.exp - claims.nbf).toBeLessThanOrEqual(60);
  const event = webhook(room);
  const ctx = context(event);
  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, { ttl: 60 });
  token.sha256 = createHash("sha256").update(ctx.rawBody).digest("base64");
  ctx.headers.authorization = await token.toJwt();
  expect((await provider.verifyWebhook(ctx)).ok).toBe(true);
  expect((await provider.verifyWebhook({ ...ctx, rawBody: `${ctx.rawBody} ` })).ok).toBe(false);
  expect(
    (await provider.verifyWebhook({ ...ctx, headers: { authorization: "bad-token-secret" } }))
      .reason,
  ).not.toContain("bad-token-secret");
  const expired = new AccessToken(livekit.apiKey, livekit.apiSecret, { ttl: -60 });
  expired.sha256 = createHash("sha256").update(ctx.rawBody).digest("base64");
  expect(
    (await provider.verifyWebhook({ ...ctx, headers: { authorization: await expired.toJwt() } }))
      .ok,
  ).toBe(false);
  const foreign = new AccessToken("foreign-key", livekit.apiSecret, { ttl: 60 });
  foreign.sha256 = expired.sha256;
  expect(
    (await provider.verifyWebhook({ ...ctx, headers: { authorization: await foreign.toJwt() } }))
      .ok,
  ).toBe(false);
  const receiver = new WebhookReceiver(livekit.apiKey, livekit.apiSecret);
  expect((await receiver.receive(ctx.rawBody, ctx.headers.authorization as string)).id).toBe(
    event.id,
  );
});

it("requires signed webhooks, valid server URL, and realtime audio", () => {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "livekit",
    livekit,
    fromNumber: from,
    inboundPolicy: "open",
  });
  expect(validateProviderConfig(config).errors).toContain("LiveKit requires realtime.enabled");
  expect(() =>
    VoiceCallConfigSchema.parse({ livekit: { ...livekit, url: "http://insecure.test" } }),
  ).toThrow();
});
