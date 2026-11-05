Poster font assets are bundled explicitly for both Node and Nitro/Vercel workers.

Sources (Google Fonts, SIL Open Font License; matching licenses are included):
- Inter.ttf: https://github.com/google/fonts/blob/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf
- Inter-Italic.ttf: https://github.com/google/fonts/blob/main/ofl/inter/Inter-Italic%5Bopsz%2Cwght%5D.ttf
- Poppins-Bold.ttf and Poppins-Regular.ttf: https://github.com/google/fonts/tree/main/ofl/poppins

Downloaded November 5, 2026. These replace missing local InterDisplay/Poppins paths;
no fighter artwork is changed. The build copies assets alongside the deployed ESM
entry. The renderer uses __dirname only when the runtime actually supplies it.
