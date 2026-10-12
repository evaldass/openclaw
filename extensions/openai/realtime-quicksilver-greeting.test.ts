import { createRealtimeVoiceBridgeSession } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { buildOpenAIQuicksilverSessionUpdate } from "./realtime-quicksilver-wire.js";
import { FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

const STARTUP = "Stock policy and tool authority.\nSYNTHETIC_PRIVATE_CONTEXT_".repeat(700);
const DIRECTIVE = 'Greet the caller now: "Hello, how can I help?" Then pause and listen.';

function fixture() {
  const socket = new FakeSocket("manual");
  socket.readyState = 1;
  let currentSocket = socket;
  const abort = new AbortController();
  const onError = vi.fn();
  const onFatalError = vi.fn();
  const onTranscript = vi.fn();
  const onResponseDone = vi.fn();
  const runAgentConsult = vi.fn(async () => ({ text: "Current result" }));
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const controller = new OpenAIQuicksilverDelegationController(
    {
      getSocket: () => currentSocket,
      signal: abort.signal,
      model: "gpt-live-1",
      logger,
      onError,
      onFatalError,
      onTranscript,
      runAgentConsult,
    },
    String,
  );
  let ready: (() => void) | undefined;
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      model: "gpt-live-1",
      instructions: STARTUP,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onResponseDone,
      onTranscript,
      onError,
      runAgentConsult,
      logger,
      resolveAuth: vi.fn(async () => {
        throw new Error("No auth permitted in this fixture");
      }),
    },
    openAIRealtimeHost,
  );
  // Adopt the real controller with a stable in-memory socket, without connect/auth/media.
  Object.assign(bridge, { delegations: controller });
  const session = createRealtimeVoiceBridgeSession({
    provider: {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        ready = request.onReady;
        return bridge;
      },
    },
    providerConfig: {},
    instructions: STARTUP,
    initialGreetingInstructions: `${STARTUP}\n\n${DIRECTIVE}`,
    initialGreetingDirective: DIRECTIVE,
    triggerGreetingOnReady: true,
    audioSink: { sendAudio: vi.fn() },
    onResponseDone,
  });
  const receive = (event: unknown) =>
    controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
  return {
    socket,
    abort,
    bridge,
    controller,
    logger,
    onError,
    onFatalError,
    onTranscript,
    onResponseDone,
    runAgentConsult,
    session,
    receive,
    ready: () => ready?.(),
    replace: () => {
      currentSocket = new FakeSocket("manual");
      currentSocket.readyState = 1;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("GPT-Live application greeting boundary (no model session)", () => {
  it.each(["oversized", "socket-send"] as const)(
    "contains %s rejection through the real sideband session.started readiness path",
    async (failure) => {
      vi.useFakeTimers();
      const socket = new FakeSocket("manual");
      socket.readyState = 1;
      const onError = vi.fn();
      const onReady = vi.fn();
      const onResponseDone = vi.fn();
      let adopted: OpenAIQuicksilverGatewayBridge | undefined;
      const session = createRealtimeVoiceBridgeSession({
        provider: {
          id: "test",
          label: "Test",
          isConfigured: () => true,
          createBridge: (request) => {
            const bridge = new OpenAIQuicksilverGatewayBridge(
              {
                ...request,
                model: "gpt-live-1",
                logger: { debug: vi.fn(), warn: vi.fn() },
                resolveAuth: async () => {
                  throw new Error("No authentication permitted");
                },
              },
              openAIRealtimeHost,
            );
            // Install the stable socket using the real controller/handler owners, without
            // connect(), authentication, network, media, or a billable model session.
            const owner = bridge as unknown as {
              sideband: FakeSocket;
              delegations: OpenAIQuicksilverDelegationController;
              createDelegationController(): OpenAIQuicksilverDelegationController;
              attachSidebandHandlers(socket: FakeSocket): void;
            };
            owner.sideband = socket;
            owner.delegations = owner.createDelegationController();
            owner.attachSidebandHandlers(socket);
            adopted = bridge;
            return bridge;
          },
        },
        providerConfig: {},
        instructions: STARTUP,
        runAgentConsult: vi.fn(async () => ({ text: "Current result" })),
        initialGreetingInstructions: `${STARTUP} opening`,
        initialGreetingDirective: failure === "oversized" ? "ė".repeat(251) : DIRECTIVE,
        triggerGreetingOnReady: true,
        audioSink: { sendAudio: vi.fn() },
        onReady,
        onError,
        onResponseDone,
      });
      if (failure === "socket-send") {
        vi.spyOn(socket, "send").mockImplementation(() => {
          throw new Error("synthetic-private-error");
        });
      }
      const start = () =>
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "session.started",
              session: {},
            }),
          ),
          false,
        );
      expect(start).not.toThrow();
      expect(start).not.toThrow();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].message).toContain(
        failure === "oversized" ? "500 UTF-8 bytes" : "could not be sent",
      );
      expect(onReady).toHaveBeenCalledOnce();
      expect(adopted?.isConnected()).toBe(true);
      expect(parseSent(socket)).toEqual([]);
      expect(onResponseDone).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      expect(onError).toHaveBeenCalledOnce();
      // A confirmed fake provider close settles cleanup without any real close handshake.
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "session.closed",
            reason: "close_requested",
          }),
        ),
        false,
      );
      await session.close();
    },
  );

  it("keeps full startup policy but sends one bounded instructions command, never bank-to-speech", () => {
    vi.useFakeTimers();
    const h = fixture();
    const startup = buildOpenAIQuicksilverSessionUpdate({
      model: "gpt-live-1",
      instructions: STARTUP,
    });
    expect(startup.session.instructions).toContain(STARTUP);
    h.ready();
    h.ready();
    const sent = parseSent(h.socket);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "session.instructions.append",
      delegation_id: null,
      content: DIRECTIVE,
    });
    expect(sent[0].event_id).toEqual(expect.any(String));
    expect(JSON.stringify(sent)).not.toContain("SYNTHETIC_PRIVATE_CONTEXT_");
    expect(h.onTranscript).not.toHaveBeenCalled();
    expect(h.runAgentConsult).not.toHaveBeenCalled();
    h.abort.abort();
  });

  it("correlates accepted acknowledgment without inventing speech, completion, user input, or consent", () => {
    vi.useFakeTimers();
    const h = fixture();
    h.ready();
    const id = parseSent(h.socket)[0].event_id;
    h.receive({
      type: "session.instructions.appended",
      client_event_id: "foreign",
      start_ms: 0,
      end_ms: 100,
    });
    expect(h.logger.debug).not.toHaveBeenCalled();
    h.receive({
      type: "session.instructions.appended",
      client_event_id: id,
      start_ms: 0,
      end_ms: 100,
    });
    h.receive({
      type: "session.instructions.appended",
      client_event_id: id,
      start_ms: 0,
      end_ms: 100,
    });
    vi.advanceTimersByTime(30_000);
    expect(h.logger.debug).toHaveBeenCalledExactlyOnceWith(
      "GPT-Live greeting instructions accepted; speech is unconfirmed",
    );
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onResponseDone).not.toHaveBeenCalled();
    expect(h.onTranscript).not.toHaveBeenCalled();
    expect(h.runAgentConsult).not.toHaveBeenCalled();
    h.abort.abort();
  });

  it.each(["reject", "timeout", "cancel", "replace", "close"] as const)(
    "settles %s without retries or stale acceptance",
    (outcome) => {
      vi.useFakeTimers();
      const h = fixture();
      h.ready();
      const id = parseSent(h.socket)[0].event_id;
      if (outcome === "reject") {
        h.receive({
          type: "error",
          error: { client_event_id: id, message: "synthetic-sensitive-details" },
        });
      } else if (outcome === "cancel") {
        h.abort.abort();
      } else if (outcome === "replace") {
        h.replace();
      } else if (outcome === "close") {
        h.controller.beginTranscriptDrain("abort");
      }
      vi.advanceTimersByTime(30_000);
      h.receive({
        type: "session.instructions.appended",
        client_event_id: id,
        start_ms: 0,
        end_ms: 100,
      });
      h.receive({ type: "error", error: { client_event_id: id, message: "stale rejection" } });
      h.ready();
      expect(parseSent(h.socket)).toHaveLength(1);
      expect(h.logger.debug).not.toHaveBeenCalled();
      expect(h.onError).toHaveBeenCalledTimes(
        outcome === "reject" || outcome === "timeout" ? 1 : 0,
      );
      expect(JSON.stringify(h.onError.mock.calls)).not.toContain("synthetic-sensitive-details");
      expect(h.onResponseDone).not.toHaveBeenCalled();
      h.abort.abort();
    },
  );

  it("ignores foreign/malformed receipts and times out only the owned command", () => {
    vi.useFakeTimers();
    const h = fixture();
    h.ready();
    const id = parseSent(h.socket)[0].event_id;
    h.receive({ type: "session.instructions.appended", client_event_id: id });
    h.receive({
      type: "session.instructions.appended",
      client_event_id: "foreign",
      start_ms: 0,
      end_ms: 100,
    });
    vi.advanceTimersByTime(15_000);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0][0].message).toContain("acknowledgment timed out");
    expect(h.onResponseDone).not.toHaveBeenCalled();
    h.abort.abort();
  });

  it("does not retain a timeout after a throwing socket send", () => {
    vi.useFakeTimers();
    const h = fixture();
    vi.spyOn(h.socket, "send").mockImplementation(() => {
      throw new Error("synthetic-sensitive-details");
    });
    expect(() => h.bridge.triggerGreeting(DIRECTIVE)).toThrow("could not be sent");
    vi.advanceTimersByTime(30_000);
    expect(h.onError).not.toHaveBeenCalled();
    h.abort.abort();
  });

  it("rejects oversized greeting directives without chunking, stripping startup policy, or sending commentary", () => {
    const h = fixture();
    expect(() => h.bridge.triggerGreeting("x".repeat(501))).toThrow("500 UTF-8 bytes");
    expect(() => h.bridge.triggerGreeting("ė".repeat(251))).toThrow("500 UTF-8 bytes");
    expect(parseSent(h.socket)).toEqual([]);
    h.abort.abort();
  });
});
