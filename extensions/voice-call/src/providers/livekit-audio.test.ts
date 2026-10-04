import type { EventEmitter } from "node:events";
import { convertPcmToMulaw8k } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, expect, it, vi } from "vitest";
import type { RealtimeMediaTransport } from "../webhook/realtime-handler.js";
import { connectLiveKitAudio, type LiveKitAudioParams } from "./livekit-audio.js";

const mock = vi.hoisted(() => ({
  capture: vi.fn(async (_frame: { data: Int16Array }) => {}),
  clear: vi.fn(),
  close: vi.fn(async () => {}),
  publish: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  subscribed: vi.fn(),
  room: undefined as EventEmitter | undefined,
  input: undefined as
    | ReadableStreamDefaultController<{ data: Int16Array; sampleRate: number }>
    | undefined,
}));

vi.mock("@livekit/rtc-node", async () => {
  const { EventEmitter } = await import("node:events");
  class Room extends EventEmitter {
    name = "openclaw-call-test";
    remoteParticipants = new Map([
      [
        "sip-test",
        {
          identity: "sip-test",
          sid: "PA_test",
          trackPublications: new Map([["TR_test", { kind: 1, setSubscribed: mock.subscribed }]]),
        },
      ],
    ]);
    localParticipant = { publishTrack: mock.publish };
    constructor() {
      super();
      mock.room = this;
    }
    async connect() {}
    disconnect = mock.disconnect;
  }
  return {
    Room,
    AudioSource: class {
      captureFrame = mock.capture;
      clearQueue = mock.clear;
      close = mock.close;
      async waitForPlayout() {}
    },
    AudioFrame: class {
      constructor(
        public data: Int16Array,
        public sampleRate: number,
        public numChannels: number,
        public samplesPerChannel: number,
      ) {}
    },
    AudioStream: class {
      constructor() {
        return new ReadableStream({
          start(controller) {
            mock.input = controller;
          },
        });
      }
    },
    LocalAudioTrack: { createAudioTrack: vi.fn(() => ({})) },
    TrackPublishOptions: class {
      constructor(public options: unknown) {}
    },
    TrackSource: { SOURCE_MICROPHONE: 2 },
    TrackKind: { KIND_AUDIO: 1 },
    RoomEvent: {
      ParticipantConnected: "participantConnected",
      TrackPublished: "trackPublished",
      ParticipantDisconnected: "participantDisconnected",
      Disconnected: "disconnected",
      TrackSubscribed: "trackSubscribed",
    },
  };
});

function harness() {
  let transport: RealtimeMediaTransport | undefined;
  const sendAudio = vi.fn();
  const endCall = vi.fn();
  let played!: () => void;
  const playedPromise = new Promise<void>((resolve) => {
    played = resolve;
  });
  const acknowledgeMark = vi.fn(() => played());
  const onDisconnect = vi.fn();
  const handler: LiveKitAudioParams["handler"] = {
    attachRoomTransport: vi.fn(async (params) => {
      transport = params.transport;
      return { sendAudio, endCall, acknowledgeMark };
    }),
  };
  const params: LiveKitAudioParams = {
    url: "wss://livekit.example.test",
    token: "synthetic-room-token",
    room: "openclaw-call-test",
    identity: "sip-test",
    participantSid: "PA_test",
    callId: "call-test",
    handler,
    isCurrent: () => true,
    onDisconnect,
  };
  return {
    params,
    sendAudio,
    endCall,
    acknowledgeMark,
    playedPromise,
    onDisconnect,
    transport: () => transport!,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mock.input = undefined;
  mock.room = undefined;
});

it("bridges supported RTC mono PCM and telephony audio, confirms marks and clears playback", async () => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  expect(mock.publish).toHaveBeenCalledOnce();
  expect(mock.subscribed).toHaveBeenCalledWith(true);
  expect(h.transport().readyState).toBe(1);
  mock.room!.emit(
    "trackSubscribed",
    { kind: 1, sid: "TR_test" },
    {},
    { identity: "sip-test", sid: "PA_test" },
  );
  const samples = new Int16Array([0, 1000, -1000, 3000]);
  mock.input!.enqueue({ data: samples, sampleRate: 8000 });
  // An explicit input delivery promise avoids real timers or polling.
  await Promise.resolve();
  await Promise.resolve();
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const mulaw = convertPcmToMulaw8k(pcm, 8000);
  expect(h.sendAudio).toHaveBeenCalledWith(mulaw);
  h.transport().send(
    JSON.stringify({ event: "media", media: { payload: mulaw.toString("base64") } }),
  );
  h.transport().send(JSON.stringify({ event: "mark", mark: { name: "played" } }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await h.playedPromise;
  expect(h.acknowledgeMark).toHaveBeenCalledWith("played");
  expect(mock.capture).toHaveBeenCalledOnce();
  expect(Array.from(mock.capture.mock.calls[0]![0].data)).toEqual([0, 988, -988, 3004]);
  h.transport().send(JSON.stringify({ event: "clear" }));
  expect(mock.clear).toHaveBeenCalledOnce();
  await connection.close();
  await connection.close();
  expect(h.endCall).toHaveBeenCalledOnce();
  expect(mock.disconnect).toHaveBeenCalledOnce();
  expect(mock.close).toHaveBeenCalledOnce();
});

it("fails closed on room/SIP SID mismatch without publishing audio or leaking token errors", async () => {
  const h = harness();
  await expect(connectLiveKitAudio({ ...h.params, participantSid: "PA_foreign" })).rejects.toThrow(
    "LiveKit RTC audio connection failed",
  );
  expect(mock.publish).not.toHaveBeenCalled();
  expect(mock.disconnect).toHaveBeenCalledOnce();
});

it("terminates on foreign peer or RTC disconnect and prevents audio after cancellation", async () => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  mock.room!.emit("participantConnected", { identity: "foreign", sid: "PA_foreign" });
  expect(h.onDisconnect).toHaveBeenCalledOnce();
  expect(h.transport().readyState).toBe(3);
  h.transport().send(JSON.stringify({ event: "media", media: { payload: "////" } }));
  await connection.close();
  expect(mock.capture).not.toHaveBeenCalled();
});

it("rejects manager cancellation during RTC admission", async () => {
  const h = harness();
  await expect(connectLiveKitAudio({ ...h.params, isCurrent: () => false })).rejects.toThrow(
    "LiveKit RTC audio connection failed",
  );
  expect(mock.publish).not.toHaveBeenCalled();
  expect(h.params.handler.attachRoomTransport).not.toHaveBeenCalled();
});
