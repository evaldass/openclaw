---
summary: "Plugin config keys, the call owner, the config reference table, and session scope"
read_when:
  - You are setting up voice-call plugin config keys
  - You need the default for a voice-call config key
  - You are choosing how call sessions are scoped
title: "Voice call configuration"
sidebarTitle: "Configuration"
---

Plugin config keys, the call owner, the full config reference table, and session scope. Part of the [Voice call plugin](/plugins/voice-call) guide.

## LiveKit server transport

LiveKit uses `wss://` by default. Configure `livekit.url`, `apiKey`, `apiSecret`,
`outboundTrunkId`, and `inboundTrunkIds`, and enable `realtime.enabled`.
Credentials support SecretRefs. SDK room/SIP API requests use HTTPS for WSS
servers, while the native RTC connection keeps the WSS URL.

For an explicitly trusted internal network only, opt in to unencrypted WS:

```json5 validate=false
{
  provider: "livekit",
  inboundPolicy: "disabled", // outbound-only; no public webhook required
  livekit: {
    url: "ws://192.168.1.10:7880",
    allowInsecureWs: true, // default: false
    apiKey: { source: "env", provider: "default", id: "LIVEKIT_API_KEY" },
    apiSecret: { source: "env", provider: "default", id: "LIVEKIT_API_SECRET" },
    outboundTrunkId: "ST_OUTBOUND_TRUNK",
    inboundTrunkIds: ["ST_INBOUND_TRUNK"],
  },
  realtime: { enabled: true },
}
```

<Warning>
`allowInsecureWs` exposes signaling, bearer tokens, and SDK HTTP API traffic to
network observers and active attackers. A private IP does not make the network
trusted. Enable it only on an isolated network you control, never over the public
internet. Migrate to `wss://` and remove the opt-in when TLS is available.
</Warning>

With the opt-in, `ws://` accepts only literal loopback or private IPs:
IPv4 `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
and IPv6 `::1` or `fc00::/7`. DNS hostnames (including `localhost`), public,
unspecified, link-local, and IPv4-mapped IPv6 addresses are rejected. SDK API
requests use HTTP for WS servers; RTC uses the configured WS URL. Embedded
credentials, query strings, and URL fragments remain forbidden for both schemes.
Webhook signature verification remains mandatory. Inbound calls still require
signed LiveKit webhooks; this transport option does not bypass caller policies,
trunk selection, or room authorization.

## Configuration

If `enabled: true` but the selected provider is missing credentials, Gateway
startup logs a setup-incomplete warning with the missing keys and skips
starting the runtime. Commands, RPC calls, and agent tools still return the
exact missing configuration when used.

<Note>
Voice-call credentials accept SecretRefs. `plugins.entries.voice-call.config.livekit.apiKey`, `plugins.entries.voice-call.config.livekit.apiSecret`, `plugins.entries.voice-call.config.twilio.authToken`, `plugins.entries.voice-call.config.realtime.providers.*.apiKey`, `plugins.entries.voice-call.config.streaming.providers.*.apiKey`, and `plugins.entries.voice-call.config.tts.providers.*.apiKey` resolve through the standard SecretRef surface; see [SecretRef credential surface](/reference/secretref-credential-surface).
</Note>

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "livekit" | "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234", // or TWILIO_FROM_NUMBER for Twilio
          toNumber: "+15550005678",
          sessionScope: "per-phone", // per-phone | per-call | main
          numbers: {
            "+15550009999": {
              inboundGreeting: "Silver Fox Cards, how can I help?",
              responseSystemPrompt: "You are a concise baseball card specialist.",
              tts: {
                providers: {
                  openai: { speakerVoice: "alloy" },
                },
              },
            },
          },

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
            // region: "ie1", // optional: us1 | ie1 | au1; defaults to us1
          },
          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx webhook public key from the Mission Control Portal
            // (Base64; can also be set via TELNYX_PUBLIC_KEY).
            publicKey: "...",
          },
          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" },

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: { enabled: true /* Twilio only; see Streaming transcription */ },
          realtime: { enabled: false /* see Realtime voice conversations */ },
        },
      },
    },
  },
}
```

### Choose the call owner

With one configured agent, Voice Call uses that agent automatically. With
multiple agents, set `plugins.entries.voice-call.config.agentId` to the intended
response and session owner. `main` is an ordinary agent ID, not a fallback for
a multi-agent fleet. Per-number routes may choose different agents for inbound
calls, but do not replace the plugin's startup owner.

If startup reports that Voice Call has no explicit owner, list your agents with
`openclaw agents list`, set the existing `agentId` field, and rerun
`openclaw voicecall setup`. With the default hybrid reload mode, the configuration
change reloads the plugin automatically; see [Hot reload](/gateway/configuration/hot-reload).
Existing legacy default-agent selection is preserved; new multi-agent setups
should use an explicit owner. See [Agent configuration](/gateway/config-agents).

### Config reference

Top-level keys under `plugins.entries.voice-call.config` not shown above:

| Key                             | Default      | Notes                                                                                                                           |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `false`      | Master on/off switch.                                                                                                           |
| `inboundPolicy`                 | `"disabled"` | `disabled` \| `allowlist` \| `pairing` \| `open`. See [Inbound calls](/plugins/voice-call/tts-and-inbound-calls#inbound-calls). |
| `allowFrom`                     | `[]`         | E.164 allowlist for `inboundPolicy: "allowlist"`.                                                                               |
| `maxDurationSeconds`            | `300`        | Hard per-call duration cap, enforced regardless of answered state.                                                              |
| `staleCallReaperSeconds`        | `120`        | See [Stale call reaper](/plugins/voice-call/tts-and-inbound-calls#stale-call-reaper). `0` disables it.                          |
| `silenceTimeoutMs`              | `800`        | End-of-speech silence detection for the classic (non-realtime) flow.                                                            |
| `transcriptTimeoutMs`           | `180000`     | Max wait for a caller transcript before giving up on a turn.                                                                    |
| `ringTimeoutMs`                 | `30000`      | Ring timeout for outbound calls.                                                                                                |
| `maxConcurrentCalls`            | `1`          | Outbound calls beyond this limit are rejected.                                                                                  |
| `outbound.notifyHangupDelaySec` | `3`          | Seconds to wait after TTS before auto-hangup in notify mode.                                                                    |
| `skipSignatureVerification`     | `false`      | Local testing only; never enable in production.                                                                                 |
| `store`                         | unset        | Overrides the default `$OPENCLAW_STATE_DIR/voice-calls` path (normally `~/.openclaw/voice-calls`).                              |
| `agentId`                       | sole agent   | Agent used for response generation and session storage. Set explicitly with multiple agents.                                    |
| `responseModel`                 | unset        | Overrides the default model for classic (non-realtime) responses.                                                               |
| `responseSystemPrompt`          | generated    | Custom system prompt for classic responses.                                                                                     |
| `responseTimeoutMs`             | `30000`      | Timeout for classic response generation (ms).                                                                                   |

Twilio defaults to its US1 REST endpoint. To process calls in a supported
non-US Region, set `twilio.region` to `ie1` or `au1` and use credentials from
that Region. See
[Twilio's non-US REST API guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region).

<AccordionGroup>
  <Accordion title="Provider exposure and security notes">
    - Twilio, Telnyx, and Plivo all require a **publicly reachable** webhook URL.
    - `mock` is a local dev provider (no network calls).
    - Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
    - `skipSignatureVerification` is for local testing only.
    - On ngrok free tier, set `publicUrl` to the exact ngrok URL; signature verification is always enforced.
    - `tunnel.allowNgrokFreeTierLoopbackBypass: true` trusts forwarding headers from loopback requests when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). This reconstructs the public URL used for signing; valid Twilio signatures are still required.
    - Ngrok free-tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures fail. Production: prefer a stable domain or a Tailscale funnel.
    - Tailscale Serve and Funnel automatically expose the realtime or streaming WebSocket path when that audio mode is enabled.
    - `tailscale.port` selects the external HTTPS port for both `tailscale.mode` and unified `tunnel.provider: "tailscale-serve" | "tailscale-funnel"`. It defaults to `443`; use `8443` when another HTTPS server owns port 443. Funnel accepts only `443`, `8443`, or `10000`, while Serve accepts any valid TCP port. Non-default ports appear in the webhook and realtime stream URLs.

  </Accordion>
  <Accordion title="Streaming connection caps">
    - `streaming.preStartTimeoutMs` (default `5000`) closes sockets that never send a valid `start` frame.
    - `streaming.maxPendingConnections` (default `32`) caps total unauthenticated pre-start sockets.
    - `streaming.maxPendingConnectionsPerIp` (default `4`) caps unauthenticated pre-start sockets per source IP.
    - `streaming.maxConnections` (default `128`) caps all open media stream sockets (pending + active).

  </Accordion>
  <Accordion title="Legacy config migrations">
    Run `openclaw doctor --fix` to rewrite these legacy keys to the canonical
    shape. The Voice Call plugin owns the migration; runtime config parsing
    accepts only the current keys. When both old and current settings exist,
    Doctor keeps the current setting, removes the legacy key, and reports which
    destination it retained. Legacy values fill only missing current fields:

    - `provider: "log"` → `provider: "mock"`
    - `twilio.from` → `fromNumber`
    - `streaming.sttProvider` → `streaming.provider`
    - `streaming.openaiApiKey` → `streaming.providers.openai.apiKey`
    - `streaming.sttModel` → `streaming.providers.openai.model`
    - `streaming.silenceDurationMs` → `streaming.providers.openai.silenceDurationMs`
    - `streaming.vadThreshold` → `streaming.providers.openai.vadThreshold`
    - `realtime.agentContext.includeSystemPrompt` is removed. Hosts with the shared context resolver always include agent-context guidance; `realtime.agentContext` controls optional configured identity and profile files. Supported older hosts retain their optional, bounded context capsule. See [Agent voice context](/plugins/voice-call/realtime-and-streaming#agent-voice-context).

  </Accordion>
</AccordionGroup>

## Session scope

By default, Voice Call uses `sessionScope: "per-phone"` so repeat calls from
the same caller keep conversation memory. Set `sessionScope: "per-call"` when
each carrier call should start with fresh context, for example reception,
booking, IVR, or Google Meet bridge flows where the same phone number may
represent different meetings.

Set `sessionScope: "main"` to route every call into the configured agent's main
session, `agent:<agentId>:main`, or `global` when core `session.scope` is
`"global"`. Custom core `session.mainKey` values are ignored. Raw call turns
then share history with the agent's primary session, so use this only when
that shared context is intentional.

For `per-phone` and `per-call`, Voice Call stores generated session keys under
the configured agent namespace (`agent:<agentId>:voice:*`). Raw explicit
integration keys resolve into the same namespace: a canonical
`agent:<configuredAgentId>:*` key keeps that owner and honors core
main-session/global-scope aliasing; foreign or malformed `agent:*` input
is scoped as an opaque key under the configured agent; `global` and `unknown`
remain global sentinels.

## LiveKit SIP telephony

`provider: "livekit"` is the telephone transport, not the realtime model.
It uses the supported LiveKit Node RTC SDK in the Gateway and the existing
Voice Call realtime bridge, including GPT-Live native agent delegation.
`realtime.enabled` is required; classic TTS/GetInput and DTMF are not supported.
Configure your model under `realtime.providers.openai.model`; leaving it unset
keeps the provider default. GPT-Live's existing function-tool limitations still
apply. No separate LiveKit Agents worker is required.

```json5 validate=false
{
  provider: "livekit",
  agentId: "main",
  fromNumber: "+15550001234",
  inboundPolicy: "allowlist",
  allowFrom: ["+15550005678"],
  sessionScope: "per-call",
  outbound: { defaultMode: "conversation" },
  livekit: {
    url: "wss://livekit.example.com",
    apiKey: { source: "env", provider: "default", id: "LIVEKIT_API_KEY" },
    apiSecret: { source: "env", provider: "default", id: "LIVEKIT_API_SECRET" },
    outboundTrunkId: "ST_outbound",
    inboundTrunkIds: ["ST_inbound"],
    roomPrefix: "openclaw-call-",
  },
  realtime: {
    enabled: true,
    provider: "openai",
    providers: { openai: { model: "gpt-live-1", voice: "marin" } }, // Platform API route; configurable.
  },
  serve: { port: 3334, path: "/voice/webhook" },
  publicUrl: "https://voice.example.com/voice/webhook",
}
```

External prerequisites (the plugin does **not** create or modify SIP trunks,
carrier routing, or dispatch rules):

1. Provision an outbound SIP trunk and select its ID with `outboundTrunkId`.
   The configured `fromNumber` must be permitted by that trunk/carrier.
2. Provision inbound trunks and a LiveKit **individual** SIP dispatch rule,
   restricted to `inboundTrunkIds`, using the exact `roomPrefix`. Reserve this
   prefix exclusively for this plugin. Set the dispatch room configuration/preset
   to `maxParticipants: 2` (one SIP caller and one OpenClaw RTC participant); the
   plugin verifies this server-enforced cap before joining. Never use a
   shared/direct conference room.
   Keep caller identity visible (`hidePhoneNumber: false`); LiveKit must supply
   `sip.trunkID`, `sip.phoneNumber`, and `sip.trunkPhoneNumber` in participant
   attributes. Anonymous callers and unselected trunks cannot enter OpenClaw.
3. Route your telephone numbers to LiveKit SIP, and configure LiveKit's signed
   webhook delivery to `publicUrl` using the configured server API key. Preserve
   the raw JSON body and `Authorization` header through your HTTPS reverse proxy.
   Private LiveKit deployments can route this webhook over their private network;
   LiveKit Cloud requires a publicly reachable HTTPS endpoint.
4. Permit RTC signaling and WebRTC media between the Gateway and LiveKit,
   including TURN where needed. Install plugin dependencies on a supported native
   RTC platform; a browser-only LiveKit client is insufficient.
5. Configure the selected realtime provider's server-side credentials separately.
   LiveKit credentials do not authorize GPT-Live/OpenAI.

API key/secret accept SecretRefs. Do not supply durable static room tokens.
Each admitted call generates a unique 60-second room-scoped microphone JWT,
without room-admin, SIP-admin, data publishing, or metadata grants. Tokens and
vendor errors are never returned to callers. The SIP caller's identity and SID
are checked before room audio is published or subscribed. Additional peers end
the call instead of receiving another caller's conversation. Existing caller
allowlist, per-number routing, agent/tool policy, duration limits, and call-owned
cancellation remain authoritative. After an unclean Gateway restart, retained
LiveKit calls are ended rather than resumed with stale audio/delegation ownership.

Offline tests do not prove carrier interoperability. Before production, validate
one authorized inbound and outbound call, rejected callers, webhook routing,
TURN/media reachability, interruption, delegation/tool policy, and cleanup after
remote hangup and Gateway shutdown using a non-production trunk. Do not count a
room successfully created as proof that two-way speech works.

LiveKit cleanup failures are recorded and retried by a service-owned 30-second
retry timer without blocking plugin startup. Rejected owned-prefix SIP rooms are
ended even when their trunk or caller attributes are invalid. Recent terminal
room tombstones use a five-minute bounded replay cache with oldest-first eviction;
cache capacity never disables admission of a new call. Long silent/DTX periods
still require live acceptance testing against the existing realtime media-inactivity
policy; offline tests do not establish that a particular SIP deployment emits
continuous silence frames.

For LiveKit only, `maxConcurrentCalls` also caps inbound admission. Existing
Plivo, Telnyx, and Twilio inbound admission behavior is unchanged. LiveKit playback
progress marks confirm a native queue prefix using the SDK's millisecond queue
estimate, not the full utterance drain; clear/barge-in and close cancel pending
mark timers before another audio generation can acknowledge them.
