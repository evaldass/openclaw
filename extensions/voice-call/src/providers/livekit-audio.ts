import { convertPcmToMulaw8k, mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeCallHandler,
  RealtimeMediaTransport,
  RealtimeRoomBinding,
} from "../webhook/realtime-handler.js";

export type LiveKitAudioConnection = { close: () => Promise<void> };
export type LiveKitAudioParams = {
  url: string;
  token: string;
  room: string;
  identity: string;
  participantSid?: string;
  callId: string;
  handler: Pick<RealtimeCallHandler, "attachRoomTransport">;
  isCurrent: () => boolean;
  onDisconnect: (reason: "completed" | "error") => void;
};

/** Native supported RTC SDK, not SIP-as-WebSocket or a browser-only shim. */
export async function connectLiveKitAudio(
  params: LiveKitAudioParams,
): Promise<LiveKitAudioConnection> {
  const rtc = await import("@livekit/rtc-node");
  const room = new rtc.Room();
  const source = new rtc.AudioSource(8000, 1, 200);
  let binding: RealtimeRoomBinding | null = null;
  let closed = false;
  let connected = false;
  let generation = 0;
  let bufferedAmount = 0;
  let output = Promise.resolve();
  let capturedSamples = 0;
  let playedSamples = 0;
  const marks = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;
  let connectPromise: Promise<void> | undefined;
  const readers = new Set<ReadableStreamDefaultReader<InstanceType<typeof rtc.AudioFrame>>>();
  const tasks = new Set<Promise<void>>();
  const trackIds = new Set<string>();
  const current = () => !closed && params.isCurrent();
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    generation++;
    binding?.endCall();
    room.removeAllListeners();
    closePromise = (async () => {
      await Promise.allSettled([...readers].map((reader) => reader.cancel()));
      await connectPromise?.catch(() => {});
      await room.disconnect();
      await output.catch(() => {});
      await source.close();
      await Promise.allSettled(marks);
      await Promise.allSettled(tasks);
    })();
    return closePromise;
  };
  const disconnected = () => {
    if (closed) return;
    params.onDisconnect("completed");
    void close().catch(() => {});
  };
  const transport: RealtimeMediaTransport = {
    get readyState() {
      return current() && connected ? 1 : 3;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
    close: (code) => {
      if (closed) return;
      params.onDisconnect(code === 1008 || code === 1011 || code === 1013 ? "error" : "completed");
      void close().catch(() => {});
    },
    send: (raw) => {
      if (!current()) return;
      const frame = JSON.parse(String(raw)) as {
        event: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      if (frame.event === "clear") {
        generation++;
        source.clearQueue();
        capturedSamples = 0;
        playedSamples = 0;
        return;
      }
      const owner = generation;
      if (frame.event === "media" && frame.media) {
        const pcm = mulawToPcm(Buffer.from(frame.media.payload, "base64"));
        const samples = new Int16Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
        bufferedAmount += pcm.length;
        output = output
          .then(async () => {
            try {
              if (current() && owner === generation) {
                await source.captureFrame(new rtc.AudioFrame(samples, 8000, 1, samples.length));
                capturedSamples += samples.length;
                playedSamples = Math.max(
                  playedSamples,
                  capturedSamples - source.queuedDuration * 8000,
                );
              }
            } finally {
              bufferedAmount -= pcm.length;
            }
          })
          .catch(disconnected);
      } else if (frame.event === "mark" && frame.mark) {
        const name = frame.mark.name;
        // Snapshot the captured prefix, but never place playout waits on the
        // capture chain: model deltas must continue feeding the native queue.
        const mark = output
          .then(async () => {
            if (!current() || owner !== generation) return;
            const boundary = capturedSamples;
            await source.waitForPlayout();
            if (current() && owner === generation) {
              playedSamples = Math.max(playedSamples, boundary);
              if (playedSamples >= boundary) binding?.acknowledgeMark(name);
            }
          })
          .catch(disconnected);
        marks.add(mark);
        void mark.finally(() => marks.delete(mark));
      }
    },
  };
  const subscribe = (participant: InstanceType<typeof rtc.RemoteParticipant>) => {
    if (!current()) return;
    if (
      participant.identity !== params.identity ||
      (params.participantSid && participant.sid !== params.participantSid)
    ) {
      // A call room must never gain a third peer that could receive assistant speech.
      disconnected();
      return;
    }
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind === rtc.TrackKind.KIND_AUDIO) publication.setSubscribed(true);
    }
  };
  room.on(rtc.RoomEvent.ParticipantConnected, subscribe);
  room.on(rtc.RoomEvent.TrackPublished, (_publication, participant) => subscribe(participant));
  room.on(rtc.RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === params.identity) disconnected();
  });
  room.on(rtc.RoomEvent.Disconnected, disconnected);
  room.on(rtc.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (
      !current() ||
      participant.identity !== params.identity ||
      (params.participantSid && participant.sid !== params.participantSid) ||
      track.kind !== rtc.TrackKind.KIND_AUDIO ||
      !track.sid ||
      trackIds.has(track.sid)
    )
      return;
    trackIds.add(track.sid);
    const reader = new rtc.AudioStream(track, {
      sampleRate: 8000,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    readers.add(reader);
    const task = (async () => {
      try {
        while (current()) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!current() || !value) continue;
          const pcm = Buffer.alloc(value.data.length * 2);
          for (let i = 0; i < value.data.length; i++) pcm.writeInt16LE(value.data[i]!, i * 2);
          binding?.sendAudio(convertPcmToMulaw8k(pcm, value.sampleRate));
        }
      } catch {
        disconnected();
      } finally {
        readers.delete(reader);
        reader.releaseLock();
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  try {
    connectPromise = room.connect(params.url, params.token, {
      autoSubscribe: false,
      dynacast: false,
    });
    await connectPromise;
    connected = true;
    if (!current() || room.name !== params.room) throw new Error("RTC room admission cancelled");
    const participant = room.remoteParticipants.get(params.identity);
    if (
      room.remoteParticipants.size !== 1 ||
      !participant ||
      (params.participantSid && participant.sid !== params.participantSid)
    )
      throw new Error("RTC SIP participant correlation failed");
    const local = room.localParticipant;
    if (!local) throw new Error("RTC local participant unavailable");
    await local.publishTrack(
      rtc.LocalAudioTrack.createAudioTrack("openclaw-voice", source),
      new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }),
    );
    if (!current()) throw new Error("RTC room admission cancelled");
    binding = await params.handler.attachRoomTransport({
      callId: params.callId,
      providerCallId: params.room,
      streamId: `rtc:${params.room}`,
      transport,
    });
    if (!binding || !current()) throw new Error("Realtime call admission failed");
    subscribe(participant);
    return { close };
  } catch {
    await close().catch(() => {});
    // Do not return vendor errors containing URL/token material.
    throw new Error("LiveKit RTC audio connection failed");
  }
}
