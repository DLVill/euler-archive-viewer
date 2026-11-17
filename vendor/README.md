# Bundled libraries

The app carries its libraries and typefaces with it, so it works offline and asks nothing of the
outside. These files are unmodified copies, except that `katex/katex.min.css` lists only the WOFF2
fonts.

| Library | Version | Licence | Files |
|---|---|---|---|
| Preact | 10.19.3 | MIT | `preact.umd.min.js`, `hooks.umd.min.js` |
| htm | 3.1.1 | Apache-2.0 | `htm.umd.min.js` |
| marked | 12.0.2 | MIT | `marked.min.js` |
| DOMPurify | 3.1.6 | Apache-2.0 or MPL-2.0 | `purify.min.js` |
| KaTeX | 0.16.9 | MIT (fonts: SIL OFL 1.1) | `katex/` |
| PDF.js | 3.11.174 | Apache-2.0 | `pdfjs/` |
| IBM Plex Sans, IBM Plex Mono | | SIL OFL 1.1 | `fonts/` |
| STIX Two Text | | SIL OFL 1.1 | `fonts/` |

To update one, replace its files with the same build of a newer version from cdnjs and change the
version here. The PDF.js library and its worker must be the same version.
