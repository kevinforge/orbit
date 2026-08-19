---
name: record-browser-gif
description: Record and verify truthful Orbit browser demos for the README, documentation, release notes, or GUI pull requests using a real Orbit server and ACP runtime; capture state-based frames, encode an optimized GIF, and publish it only when explicitly requested. Use when asked to make, record, generate, or attach a GIF that demonstrates an Orbit web workflow.
---

# Record Browser GIF

Produce a short, truthful Orbit UI demonstration as a local GIF. Use the
browser-control skill for interaction and the bundled encoder for repeatable
timing, dimensions, and size. This skill is the canonical project workflow;
do not copy a second full version into a host-specific directory.

## Recording integrity

- Record from the real Orbit server and the real UI path that the GIF claims to
  demonstrate. Do not substitute fixture requests, mock transports, synthetic
  event injection, or test-only hooks unless the user explicitly requests a
  fixture recording.
- Use a benign demonstration prompt. Never expose API keys, login state,
  personal data, unrelated tabs, or private workspace paths in a frame.
- Keep one storyboard in one isolated run. Do not splice frames from different
  servers, browser profiles, workspaces, or model rounds.
- If the recording supports a pull request claim, record the exact commit with
  `git rev-parse HEAD` and state that commit beside the embedded GIF.
- If credentials, a supported runtime, or the server are unavailable, report
  the limitation instead of presenting a fixture as a real run.

## Stage Orbit

1. Read the root `AGENTS.md` and the relevant product docs. For the current
   collaboration demo, read `docs/ARCHITECTURE.md` and
   `docs/TERMINOLOGY_AND_ROUTING.md`.
2. For a pull-request recording, require a clean worktree and record the exact
   commit before building. For a README or documentation recording, record the
   current branch and note that provenance in the handoff.
3. Build the UI from that tree:

   ```powershell
   npm run build
   ```

   The build requires Bun because it compiles the standalone executable. The
   source server itself runs with Node and the repository's npm scripts.
4. Start Orbit with `npm run dev` and use `http://localhost:4317`, or set
   `ORBIT_PORT` to an available port. Keep one server for the whole storyboard.
5. Use a fresh browser context or clear only the demo origin's storage before
   navigation. Orbit stores product data under `~/.orbit`; do not delete or
   overwrite a user's existing data to create a clean recording. Use a
   dedicated demo workspace and remove only artifacts created for the recording
   when cleanup is explicitly safe.
6. Stop the exact server process after capture. Do not use a broad process-kill
   pattern that could terminate the shell or another Orbit instance.

## Record the story

1. Invoke the available browser-control skill. If it is unavailable, use the
   repository's existing Playwright dependency in an isolated browser; do not
   install another driver or launch the user's browser unless requested.
2. Before recording, identify the origin, built/development mode, runtime,
   transport, and whether the run is real or fixture-backed. State exceptions
   in the final provenance.
3. Choose three to six semantic states that tell one story. A useful Orbit
   README storyboard is: workspace and team visible, assignment typed, employee
   running, handoff or verification visible, and final settled result.
4. Keep one viewport and crop for every frame. Write frames under the ignored
   `.playwright-mcp/gif-frames-<label>/` directory and name them lexically:
   `00-initial.png`, `01-assigned.png`, `02-running.png`, and so on.
5. Before each screenshot, wait for a concrete UI condition such as a unique
   label, an enabled control, a changed heading, a visible run state, or an
   exact final reply. Do not use a fixed delay as proof that the UI reached a
   state.
6. When checking completion, match an exact-text element rather than a broad
   `body.textContent.includes(...)` check, which can match the echoed prompt.
7. When the claim involves approval, tool activity, handoff, failure, or
   recovery, include a frame that visibly proves that state. A final chat reply
   alone does not prove the preceding path.
8. Capture transient states by driving a real foreground operation and polling
   a concrete DOM marker in the same browser-script call that takes the
   screenshot. Stop unnecessarily long real-model runs once the demonstrated
   state is visible.

Use the browser's screenshot API and save the returned image bytes directly.

## Encode the GIF

Require `python3` or `python`, `ffmpeg`, and `ffprobe`. If a required media
binary is missing, report it instead of installing software without approval.

On PowerShell:

```powershell
$gifSkillDir = (Resolve-Path ".agents/skills/record-browser-gif").Path
python "$gifSkillDir/scripts/encode_gif.py" `
  "$(Resolve-Path '.playwright-mcp/gif-frames-<label>')" `
  "$(Resolve-Path '.playwright-mcp')/orbit-demo.gif" `
  --durations 1.5,1.5,1.5,3.5 `
  --fps 10 `
  --max-width 1200 `
  --colors 128
```

On a POSIX shell, export the skill directory before invoking Python:

```sh
export GIF_SKILL_DIR="$PWD/.agents/skills/record-browser-gif"
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  "$PWD/.playwright-mcp/gif-frames-<label>" \
  "$PWD/.playwright-mcp/orbit-demo.gif" \
  --durations 1.5,1.5,1.5,3.5 \
  --fps 10 \
  --max-width 1200 \
  --colors 128
```

Provide one positive duration per frame, holding the final state longest. The
encoder rejects fewer than two frames, mismatched dimensions or durations,
invalid limits, accidental overwrite, unexpected duration, and oversized
output. Reduce `--max-width` first when text is still readable; then reduce
colors or FPS. Use `--force` only after checking the exact output path.

## Verify the artifact

1. Read the encoder's JSON summary. Confirm output path, source and encoded
   frame counts, dimensions, duration, and byte size.
2. Inspect the encoded GIF itself, not only the source screenshots. Confirm that
   transitions are legible, the final state is held long enough, and no private
   data appears. Decode representative frames with `ffmpeg` if the viewer only
   exposes the first frame.
3. Run `git status --short` and confirm frames and the GIF are under ignored
   paths unless the user explicitly requested publication.
4. Return the absolute GIF path and state whether it used a real ACP/model run,
   a fixture, or another transport. Render the local GIF when the client
   supports local media.

## Publish for README or pull-request use

Only publish when the user explicitly asks for a GitHub-visible README or
pull-request asset. Prefer a dedicated assets branch such as `orbit-assets` so
the product branch does not accumulate binary history. Verify that the branch
contains media only and that the remote checksum matches the verified local GIF.

Embed a published GIF with a raw blob URL:

```markdown
![Orbit multi-agent collaboration demo](https://github.com/<owner>/<repo>/blob/orbit-assets/orbit-demo.gif?raw=true)
```

For a pull request, record the demonstrated commit SHA, server origin, runtime,
browser-state exception if any, and whether a real model round ran next to the
GIF. Re-read the live pull-request head before and after editing its body; if it
moved, re-record. Never force-push or rewrite an assets branch.
