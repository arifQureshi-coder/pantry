# Pantry

A personal grocery inventory and expiry tracker. It is a PWA for iPhone (Safari › Share › Add to Home Screen).
There is no backend and no account. All data is kept in IndexedDB on the phone.

## Commands
- `npm install`: install dependencies
- `npm run dev`: dev server (camera needs HTTPS or localhost)
- `npm run build`: type-check, then build static files into `dist/`
- `npm run preview`: serve `dist/` locally
- `npm run test:dates`: run the expiry date parser tests
- Open with `?demo` on an empty install to load sample items.

## AI
In Settings, choose **Google Gemini** (the default, with a free key from https://aistudio.google.com/app/apikey) or **OpenAI**.
The key is stored only on the device. Requests go directly from the phone to the provider.

## Deploy (GitHub Pages)
1. Create a repo (e.g. `pantry`) and push this folder to `main`.
2. In the repo, go to Settings › Pages › Source and choose **GitHub Actions**. `.github/workflows/deploy.yml` builds and publishes `dist/`.
3. Open `https://<username>.github.io/pantry/` in Safari on the iPhone, then Share › Add to Home Screen.

`vite.config.ts` uses `base: './'`, so the build works from any sub-path.
