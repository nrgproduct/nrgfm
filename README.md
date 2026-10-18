# nrgfm

A searchable archive of songs shared since 2010, rebuilt from a Facebook group export.

- `index.html`, `app.js`, `style.css` – the site (no build step, no dependencies).
- `data/tracks.json` – threads and tracks (main track first, similar tracks after).
- `data/meta.json` – titles, channels, thumbnails, fetched automatically by GitHub Actions.
- `inbox/` – tracks added through the site's "Add track" button land here, then get merged.
- `scripts/` – data tools. `build_data.py` rebuilt the archive from the export; `ingest_inbox.py` and `fetch_meta.py` run in `.github/workflows/update.yml`.

Publishing: Settings → Pages → Source: **GitHub Actions**. Every push to `main` updates titles and republishes.

The site asks search engines not to index it (`noindex`), but anyone with the link can open it.
