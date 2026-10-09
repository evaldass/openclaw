---
summary: "Validate the LiveKit voice-call candidate with a matching source host"
read_when:
  - Testing the LiveKit voice-call provider from a source checkout
  - Diagnosing scheduler imports or durable-state trust refusals
---

# LiveKit candidate host compatibility

An unpublished provider package is not a replacement for a compatible host. This
candidate retains the host's voice-call prompts, consultation, session lineage and
durable storage. Do not replace these with plugin-owned conversation or storage
implementations to make an incompatible installation appear healthy.

## Supported development route

A complete matching source installation is supported for bundled development;
official catalog publication is not the only way to test privileged bundled code.
Follow [From source](/install#from-source) with the reviewed repository revision,
its pinned pnpm dependencies, and normal build tools. Run the resulting host with
a fresh state/config/workspace and separate loopback ports. Do not link it over
an existing production CLI or install a daemon for a disposable canary.

The running host's own `extensions/voice-call` (or corresponding built bundled
entry) has bundled provenance. This trusts the complete reviewed host snapshot,
not an arbitrary same-named plugin. Inspect `plugins inspect voice-call --runtime
--json` and require the expected source, `origin: bundled`, and loaded status.
Source runners select their own checkout; see [Plugin architecture](/plugins/architecture)
and [Debugging](/help/debugging). Rebuild changed bundled output before testing.

An `npm-pack:` install is useful for dependency/package-shape tests, but a local
archive is not a trusted official publication. Allowlists, renaming, link installs,
and copied install records do not grant privileged durable state. Never override
provenance or weaken a trust guard to pass acceptance.

## Known shipping-host boundary

The checked OpenClaw 2026.9.9 build
`bcfc88812a35243893585dbeca87ca41b48272ca` does not implement the service V2
scheduler used by this candidate. Its SDK lacks `resolvePluginServiceScheduler`,
and its service context lacks `scheduler`. Exporting a resolver alone is therefore
insufficient. The candidate scheduler owns callback execution context,
cancellation and joined shutdown; a local timer shim is not equivalent.

That shipping core also lacks this branch's detached realtime-consult admission
repair. Installing a plugin cannot replace the host consultation implementation.
Use a complete matching reviewed host, or separately review a full backport/port.
Semantic version strings alone cannot prove these APIs exist.

## Acceptance and rollback

Keep separate evidence for shipping-core negative tests, candidate source-host
checks, and packaged installation checks. None substitutes for the others.

- Require service startup without import or trust errors; Gateway readiness alone
  is insufficient. Initialization must fail when durable store admission or
  restoration fails, rather than treating inaccessible history as empty.
- Write and reopen synthetic records through the plugin-scoped host state API.
  Do not copy production databases, sessions, credentials, or call records.
- Verify detached consultations survive a released request owner, while restart
  and suspension fences still reject/wait and respect cancellation. Stub model
  execution in regression tests; do not infer speech/carrier quality from them.
- Verify shutdown joins work and closes its webhook port. Stop only the disposable
  process, remove only its isolated installation/link, and confirm both canary
  ports are closed. Preserve logs for audit.

A source-host canary proves that candidate combination, not compatibility with
the shipping host or official catalog provenance. Production deployment of a
different host requires separate authorization and normal product validation.
