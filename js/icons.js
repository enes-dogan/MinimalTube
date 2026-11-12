/* MinimalTube player - The icons the scripts draw (the ones in player.html are written there).
 * Loaded in order by player.html (classic scripts sharing one scope). */

const ICON_GRIP =
  '<svg viewBox="0 0 12 16" fill="currentColor"><circle cx="3.5" cy="3" r="1.4"/><circle cx="8.5" cy="3" r="1.4"/><circle cx="3.5" cy="8" r="1.4"/><circle cx="8.5" cy="8" r="1.4"/><circle cx="3.5" cy="13" r="1.4"/><circle cx="8.5" cy="13" r="1.4"/></svg>';
const ICON_DOTS =
  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const ICON_CHANNEL =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
const ICON_REMOVE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm11.41 6L17 19.41 19.59 22 21 20.59 18.41 18 21 15.41 19.59 14 17 16.59 14.41 14 13 15.41 15.59 18 13 20.59z"/></svg>';
const ICON_BOOKMARK =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15-5-2.18L7 18V5h10v13z"/></svg>';
const ICON_BOOKMARK_FILLED =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>';
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_ADDLIST =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h12v2H3zM3 11h12v2H3zM3 16h8v2H3zM18 13v3h-3v2h3v3h2v-3h3v-2h-3v-3z"/></svg>';
const ICON_NEXT =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h11v2H3zM3 11h11v2H3zM3 16h7v2H3zM16 10v8l6-4z"/></svg>';
const ICON_SYNC =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
const ICON_UNLINK =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16v-2zM2 4.27l3.11 3.11A4.99 4.99 0 0 0 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4L20 19.74 3.27 3 2 4.27z"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
// the Settings button that moves the player: into its own window, into a browser tab
const ICON_TO_WINDOW =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h5V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-5h-2v5H5V5z"/></svg>';
const ICON_TO_TAB =
  '<svg viewBox="0 0 512 512" fill="currentColor" fill-rule="evenodd"><path d="M98 425.7C82.1 422.1 69.5 410 65.5 394.4C64.1 389 64 372.7 64.2 253.4L64.5 118.5L66.9 112.7C71.3 101.6 81.2 92 92.7 87.7L98.5 85.5L252 85.2C360.5 85 407.4 85.2 411.9 86C424.5 88.2 435.3 95.5 441.7 106.1C448.3 117.2 448 109.7 448 256C448 402.3 448.3 394.8 441.7 405.9C435.4 416.5 424.5 423.8 411.9 426C407.7 426.7 393.3 427 370.5 426.8L335.5 426.5L330.8 423.7C322.4 418.8 318.4 408.8 321.1 399.3C322.7 393.4 329.2 386.6 334.6 385.1C337 384.4 351.2 384 371.8 384L405 384L405 277.5L405 171L256 171L107 171L107 277.5L107 384L140.2 384C160.8 384 175 384.4 177.4 385.1C182.8 386.6 189.3 393.4 190.9 399.3C193.6 408.8 189.6 418.8 181.2 423.7L176.5 426.5L140 426.7C114.2 426.8 101.9 426.5 98 425.7ZM249.8 425.6C244.1 423.5 241.3 421.4 238.2 416.8L235.5 412.6L235.2 355.8L235 299L215.4 299C194.9 299 191.4 298.4 187.7 294.3C186.7 293.2 185.6 290.6 185.3 288.6L184.7 284.9L217.1 252.4C243.5 226 250.2 219.8 253.3 218.9C261.3 216.8 261.3 216.8 294.9 250.4C323.6 279.1 326.2 282 326.6 285.6C327 288.4 326.5 290.4 325 292.8C321.6 298.3 318.5 299 296.6 299L277 299L276.8 355.9L276.5 412.8L273.5 417.2C268 424.9 257.7 428.6 249.8 425.6Z"/></svg>';
