// marpExport — download a Marp deck as a real, standalone Marp presentation.
//
// The deck is rendered server-side by the marp CLI (bespoke template: keyboard
// and touch navigation, fullscreen, presenter view), so the download is a
// genuine, self-contained Marp deck rather than a static dump of slide images.
import { exportMarpHtml } from './api.js';

function baseName(path) {
  const b = String(path || 'deck').split('/').pop() || 'deck';
  return b.replace(/\.md$/i, '') || 'deck';
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// exportHtml downloads a real, standalone Marp presentation. The rendering is
// done server-side by the marp CLI (bespoke template: keyboard/touch
// navigation, fullscreen, presenter view), so the result is a genuine,
// self-contained deck rather than a static dump of slide images.
export async function exportHtml(content, title) {
  const blob = await exportMarpHtml(content, baseName(title));
  downloadBlob(`${baseName(title)}.html`, blob);
}
