import { createHash, randomUUID } from "node:crypto";
import {
  AccessToken,
  ServerError,
  RoomServiceClient,
  SipClient,
  WebhookReceiver,
  type WebhookEvent,
} from "livekit-server-sdk";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { LiveKitConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type {
  AnswerCallInput,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  WebhookContext,
  WebhookVerificationResult,
  ProviderWebhookParseResult,
} from "../types.js";
import type { RealtimeCallHandler } from "../webhook/realtime-handler.js";
import type { VoiceCallProvider } from "./base.js";
import { connectLiveKitAudio, type LiveKitAudioConnection } from "./livekit-audio.js";

type CallRoom = {
  room: string;
  callId: string;
  identity: string;
  participantSid?: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  closed: boolean;
  connection?: LiveKitAudioConnection;
  joining?: Promise<void>;
};

export type LiveKitDependencies = {
  rooms: Pick<RoomServiceClient, "createRoom" | "deleteRoom" | "listParticipants" | "listRooms">;
  sip: Pick<SipClient, "createSipParticipant">;
  receiver: Pick<WebhookReceiver, "receive">;
  connectAudio: typeof connectLiveKitAudio;
};

/** Telephony owner. Realtime models/delegation remain owned by RealtimeCallHandler. */
export class LiveKitProvider implements VoiceCallProvider {
  readonly name = "livekit" as const;
  private readonly calls = new Map<string, CallRoom>();
  private readonly retiredRooms = new Map<string, number>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly answers = new Map<string, Promise<void>>();
  private readonly verified = new WeakMap<WebhookContext, WebhookEvent>();
  private readonly deps: LiveKitDependencies;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private manager?: CallManager;
  private handler?: RealtimeCallHandler;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly disconnectFailures = new Set<string>();
  private readonly pendingCleanup = new Set<string>();
  private readonly restoredCleanup = new Set<string>();
  private cleanupRetryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly config: LiveKitConfig,
    deps?: LiveKitDependencies,
  ) {
    this.apiKey =
      normalizeResolvedSecretInputString({ value: config.apiKey, path: "livekit.apiKey" }) ?? "";
    this.apiSecret =
      normalizeResolvedSecretInputString({ value: config.apiSecret, path: "livekit.apiSecret" }) ??
      "";
    if (!this.apiKey || !this.apiSecret)
      throw new Error("LiveKit server credentials are not resolved");
    const host = config.url.replace(/^ws(s?):/i, (_match, secure: string) =>
      secure ? "https:" : "http:",
    );
    this.deps = deps ?? {
      rooms: new RoomServiceClient(host, this.apiKey, this.apiSecret),
      sip: new SipClient(host, this.apiKey, this.apiSecret),
      receiver: new WebhookReceiver(this.apiKey, this.apiSecret),
      connectAudio: connectLiveKitAudio,
    };
  }

  bind(manager: CallManager, handler: RealtimeCallHandler): void {
    this.manager = manager;
    this.handler = handler;
  }

  /** A crashed RTC session cannot safely reuse its delegation/audio ownership. */
  private retire(room: string): void {
    this.retiredRooms.delete(room);
    this.retiredRooms.set(room, Date.now() + 300000);
    while (this.retiredRooms.size > 4096)
      this.retiredRooms.delete(this.retiredRooms.keys().next().value!);
  }

  private rejectRoom(room: string): void {
    this.retire(room);
    const cleanup = this.deleteRoom(room);
    this.operations.add(cleanup);
    void cleanup.then(
      () => this.operations.delete(cleanup),
      () => {
        this.operations.delete(cleanup);
        console.warn("[voice-call] LiveKit rejected room cleanup pending retry");
      },
    );
  }

  private async deleteRoom(room: string): Promise<void> {
    try {
      await this.deps.rooms.deleteRoom(room);
    } catch (error) {
      if (!(error instanceof ServerError && error.code === "not_found")) {
        this.pendingCleanup.add(room);
        this.scheduleCleanupRetry();
        throw new Error("LiveKit room cleanup failed");
      }
    }
    this.pendingCleanup.delete(room);
  }

  private scheduleCleanupRetry(): void {
    if (this.stopping || this.cleanupRetryTimer) return;
    this.cleanupRetryTimer = setTimeout(() => {
      this.cleanupRetryTimer = undefined;
      const retry = this.retryPendingCleanup();
      this.operations.add(retry);
      void retry.finally(() => {
        this.operations.delete(retry);
        if (this.pendingCleanup.size) this.scheduleCleanupRetry();
      });
    }, 30000);
    this.cleanupRetryTimer.unref();
  }

  async retryPendingCleanup(): Promise<void> {
    for (const room of [...this.pendingCleanup]) {
      try {
        const call = this.manager?.getCallByProviderCallId(room);
        if (this.restoredCleanup.has(room) && call) {
          const ended = await this.manager!.endCall(call.callId, { reason: "completed" });
          if (!ended.success) continue;
          this.restoredCleanup.delete(room);
        } else {
          await this.deleteRoom(room);
          this.restoredCleanup.delete(room);
        }
      } catch {
        console.warn("[voice-call] LiveKit room cleanup pending retry");
      }
    }
  }

  async retireRestoredCalls(): Promise<void> {
    for (const call of this.manager?.getActiveCalls() ?? []) {
      if (
        call.provider === "livekit" &&
        call.providerCallId &&
        !this.calls.has(call.providerCallId)
      ) {
        const result = await this.manager!.endCall(call.callId, { reason: "completed" });
        if (!result.success) {
          this.restoredCleanup.add(call.providerCallId);
          this.pendingCleanup.add(call.providerCallId);
          this.scheduleCleanupRetry();
          console.warn(
            "[voice-call] LiveKit restored call cleanup pending retry; RTC admission disabled for retained call",
          );
        }
      }
    }
  }

  async roomToken(room: string): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: `openclaw-${randomUUID()}`,
      ttl: 60,
    });
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: [2],
    });
    return token.toJwt();
  }

  async verifyWebhook(ctx: WebhookContext): Promise<WebhookVerificationResult> {
    this.verified.delete(ctx);
    const header = ctx.headers.authorization;
    if (ctx.method !== "POST" || typeof header !== "string")
      return { ok: false, reason: "Missing LiveKit authorization" };
    try {
      const event = await this.deps.receiver.receive(ctx.rawBody, header);
      if (!event.id) return { ok: false, reason: "Missing LiveKit event ID" };
      this.verified.set(ctx, event);
      return {
        ok: true,
        verifiedRequestKey: `livekit:${createHash("sha256").update(ctx.rawBody).digest("hex")}`,
      };
    } catch {
      return { ok: false, reason: "Invalid LiveKit webhook signature" };
    }
  }

  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    const event = this.verified.get(ctx);
    this.verified.delete(ctx);
    if (!event) return { events: [] };
    const room = event.room?.name;
    if (!room?.startsWith(this.config.roomPrefix)) return { events: [] };
    const now = Date.now();
    for (const [name, expiry] of this.retiredRooms)
      if (expiry <= now) this.retiredRooms.delete(name);
    if (this.retiredRooms.has(room)) return { events: [] };
    let call = this.calls.get(room);
    if (!call && event.event === "room_finished") {
      this.retire(room);
      return { events: [] };
    }
    const participant = event.participant;
    if (!call && event.event === "participant_joined" && participant?.kind === 3) {
      const attrs = participant.attributes;
      if (this.stopping || !this.manager || !this.handler || this.restoredCleanup.has(room)) {
        this.rejectRoom(room);
        return { events: [] };
      }
      if (
        !this.config.inboundTrunkIds.includes(attrs["sip.trunkID"] ?? "") ||
        !/^\+[1-9]\d{1,14}$/.test(attrs["sip.phoneNumber"] ?? "") ||
        !/^\+[1-9]\d{1,14}$/.test(attrs["sip.trunkPhoneNumber"] ?? "")
      ) {
        this.rejectRoom(room);
        return { events: [] };
      }
      call = {
        room,
        callId: room,
        identity: participant.identity,
        participantSid: participant.sid,
        direction: "inbound",
        from: attrs["sip.phoneNumber"]!,
        to: attrs["sip.trunkPhoneNumber"]!,
        closed: false,
      };
      this.calls.set(room, call);
    }
    if (!call || call.closed) return { events: [] };
    if (
      event.event !== "room_finished" &&
      (!participant ||
        participant.identity !== call.identity ||
        (call.participantSid && participant.sid !== call.participantSid))
    )
      return { events: [] };
    const base = {
      id: `livekit:${event.id}`,
      dedupeKey: `livekit:${event.id}`,
      callId: call.callId,
      providerCallId: room,
      timestamp: Number(event.createdAt) > 0 ? Number(event.createdAt) * 1000 : now,
      direction: call.direction,
      from: call.from,
      to: call.to,
    };
    const events: NormalizedEvent[] = [];
    if (event.event === "participant_joined" && call.direction === "inbound")
      events.push({ ...base, type: "call.initiated" });
    if (
      event.event === "participant_left" ||
      event.event === "participant_connection_aborted" ||
      event.event === "room_finished"
    ) {
      const cleanup = this.dispose(call);
      this.operations.add(cleanup);
      void cleanup.then(
        () => this.operations.delete(cleanup),
        () => {
          this.operations.delete(cleanup);
          console.warn("[voice-call] LiveKit call cleanup failed");
        },
      );
      events.push({ ...base, type: "call.ended", reason: "completed" });
    }
    return { events, providerResponseBody: "", statusCode: 200 };
  }

  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const work = this.dial(input);
    this.operations.add(work);
    void work.then(
      () => this.operations.delete(work),
      () => this.operations.delete(work),
    );
    return work;
  }

  private async dial(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (this.stopping || !this.manager || !this.handler)
      throw new Error("LiveKit runtime is not ready");
    const room = `${this.config.roomPrefix}${randomUUID()}`;
    const call: CallRoom = {
      room,
      callId: input.callId,
      identity: `sip-${input.callId}`,
      direction: "outbound",
      from: input.from,
      to: input.to,
      closed: false,
    };
    this.calls.set(room, call);
    try {
      await this.manager.processEvent({
        id: `livekit-dial:${room}`,
        callId: input.callId,
        providerCallId: room,
        timestamp: Date.now(),
        type: "call.initiated",
      });
      if (this.stopping || call.closed || !this.manager.getCall(input.callId))
        throw new Error("Call cancelled");
      await this.deps.rooms.createRoom({ name: room, maxParticipants: 2, emptyTimeout: 60 });
      if (this.stopping || call.closed || !this.manager.getCall(input.callId))
        throw new Error("Call cancelled");
      const participant = await this.deps.sip.createSipParticipant(
        this.config.outboundTrunkId,
        input.to,
        room,
        {
          fromNumber: input.from,
          participantIdentity: call.identity,
          waitUntilAnswered: true,
        },
      );
      call.participantSid = participant.participantId;
      if (this.stopping || call.closed || !this.manager.getCall(input.callId))
        throw new Error("Call cancelled");
      await this.join(call);
      return { providerCallId: room, status: "initiated" };
    } catch {
      try {
        await this.dispose(call);
      } catch {
        throw new Error("LiveKit call setup failed; room cleanup pending retry");
      }
      throw new Error(
        "LiveKit call setup failed; check trunk, connectivity, and realtime configuration",
      );
    }
  }

  answerCall(input: AnswerCallInput): Promise<void> {
    const pending = this.answers.get(input.providerCallId);
    if (pending) return pending;
    const work = this.answer(input);
    this.answers.set(input.providerCallId, work);
    this.operations.add(work);
    const settled = () => {
      this.answers.delete(input.providerCallId);
      this.operations.delete(work);
    };
    void work.then(settled, settled);
    return work;
  }

  private async answer(input: AnswerCallInput): Promise<void> {
    const call = this.calls.get(input.providerCallId);
    if (!call || call.closed) return;
    call.callId = input.callId;
    try {
      await this.join(call);
    } catch {
      await this.manager?.endCall(input.callId, { reason: "error" });
    }
  }

  private join(call: CallRoom): Promise<void> {
    if (call.joining) return call.joining;
    call.joining = (async () => {
      if (!this.manager || !this.handler || call.closed || this.stopping)
        throw new Error("Call inactive");
      const [participants, rooms] = await Promise.all([
        this.deps.rooms.listParticipants(call.room),
        this.deps.rooms.listRooms([call.room]),
      ]);
      if (rooms.length !== 1 || rooms[0]?.name !== call.room || rooms[0].maxParticipants !== 2)
        throw new Error("LiveKit call rooms require maxParticipants: 2");
      if (
        participants.length !== 1 ||
        participants[0]?.identity !== call.identity ||
        (call.participantSid && participants[0].sid !== call.participantSid)
      )
        throw new Error("Room is not isolated to the correlated SIP caller");
      const record = await this.manager.getCallForStream(call.callId);
      if (!record || record.providerCallId !== call.room || call.closed || this.stopping)
        throw new Error("Call inactive");
      const token = await this.roomToken(call.room);
      if (call.closed || this.stopping || this.manager.getCall(call.callId) !== record)
        throw new Error("Call inactive");
      const connection = await this.deps.connectAudio({
        url: this.config.url,
        token,
        room: call.room,
        identity: call.identity,
        participantSid: call.participantSid,
        callId: call.callId,
        handler: this.handler,
        isCurrent: () =>
          !call.closed && !this.stopping && this.manager?.getCall(call.callId) === record,
        onDisconnect: (reason) => {
          void this.manager?.endCall(call.callId, { reason });
        },
      });
      if (call.closed || this.stopping) {
        await connection.close();
        throw new Error("Call inactive");
      }
      call.connection = connection;
    })();
    return call.joining;
  }

  private async dispose(call: CallRoom): Promise<void> {
    call.closed = true;
    this.retire(call.room);
    try {
      await call.connection?.close();
    } catch {
      // Room deletion is still mandatory. A successful unrelated deletion must
      // never erase an RTC disconnect failure (close promises are idempotent).
      this.disconnectFailures.add(call.room);
    }
    await this.deleteRoom(call.room);
    this.calls.delete(call.room);
    if (this.disconnectFailures.has(call.room)) throw new Error("LiveKit RTC disconnect failed");
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const call = this.calls.get(input.providerCallId);
    if (call) await this.dispose(call);
    else if (input.providerCallId.startsWith(this.config.roomPrefix)) {
      this.retire(input.providerCallId);
      await this.deleteRoom(input.providerCallId);
    } else throw new Error("LiveKit call room is outside the configured room prefix");
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const result = this.handler?.speak(input.callId, input.text);
    if (!result?.success) throw new Error("LiveKit realtime call is not ready for speech");
  }
  async startListening(): Promise<void> {}
  async stopListening(): Promise<void> {}
  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    if (!input.providerCallId.startsWith(this.config.roomPrefix))
      return { status: "unknown", isTerminal: false, isUnknown: true };
    try {
      const participants = await this.deps.rooms.listParticipants(input.providerCallId);
      return {
        status: participants.some((p) => p.kind === 3) ? "active" : "completed",
        isTerminal: !participants.some((p) => p.kind === 3),
      };
    } catch (error) {
      if (error instanceof ServerError && error.code === "not_found")
        return { status: "completed", isTerminal: true };
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.cleanupRetryTimer) clearTimeout(this.cleanupRetryTimer);
    this.stopPromise = (async () => {
      const cleanup = await Promise.allSettled(
        [...this.calls.values()].map(async (call) => {
          const record = this.manager?.getCallByProviderCallId(call.room);
          if (record) {
            const ended = await this.manager!.endCall(record.callId, { reason: "completed" });
            if (!ended.success) await this.dispose(call);
          } else await this.dispose(call);
          await call.joining?.catch(() => {});
        }),
      );
      await Promise.allSettled(this.operations);
      await this.retryPendingCleanup();
      if (
        this.pendingCleanup.size > 0 ||
        this.disconnectFailures.size > 0 ||
        cleanup.some((result) => result.status === "rejected")
      ) {
        throw new Error("LiveKit room cleanup failed during shutdown");
      }
    })();
    return this.stopPromise;
  }
}
