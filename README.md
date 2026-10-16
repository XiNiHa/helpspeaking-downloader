# helpspeaking-downloader

Fetches recent helpspeaking.kr lesson recordings, makes them seekable with ffmpeg in a Cloudflare Container, and serves them from R2 behind a pattern-locked PWA.

```
pnpm i
pnpm dev          # needs Docker for the transcoder container
pnpm run deploy
pnpm db:generate  # after editing src/db/schema.ts
pnpm db:migrate
pnpm typegen      # after editing wrangler.toml
```
