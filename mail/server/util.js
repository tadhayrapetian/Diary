import libqp from 'libqp';
import libbase64 from 'libbase64';
import iconv from 'iconv-lite';

export * from './text.js';

/** Decode a body part fetched raw over IMAP (transfer encoding, then charset). */
export function decodePart(buffer, { encoding = '7bit', charset = 'utf-8', binary = false } = {}) {
  if (!buffer) return '';
  let bytes = buffer;
  if (!binary) {
    const enc = String(encoding).toLowerCase();
    if (enc === 'base64') {
      // A partial fetch can stop mid-quantum; trim to whole 4-char groups.
      const clean = buffer.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
      bytes = libbase64.decode(clean.slice(0, clean.length - (clean.length % 4)));
    } else if (enc === 'quoted-printable') {
      bytes = libqp.decode(buffer.toString('binary'));
    }
  }
  const cs = String(charset || 'utf-8').toLowerCase();
  try {
    return iconv.encodingExists(cs) ? iconv.decode(bytes, cs) : bytes.toString('utf8');
  } catch {
    return bytes.toString('utf8');
  }
}

/** Walk a BODYSTRUCTURE and find the best part to preview. */
export function findTextPart(node, prefer = 'text/plain') {
  let best = null;
  const visit = (n, fallbackPart) => {
    if (!n) return;
    const part = n.part || fallbackPart;
    if (n.childNodes?.length) {
      n.childNodes.forEach((child, i) => visit(child, part ? `${part}.${i + 1}` : String(i + 1)));
      return;
    }
    if (n.disposition === 'attachment') return;
    const type = String(n.type || '').toLowerCase();
    if (type === prefer && !best) best = { ...n, part };
    else if (type.startsWith('text/') && (!best || (best.type !== prefer && type === prefer))) {
      best = best || { ...n, part };
    }
  };
  visit(node, '1');
  return best;
}

/** True if a BODYSTRUCTURE carries at least one real attachment. */
export function hasAttachments(node) {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachments);
  if (node.disposition === 'attachment') return true;
  const type = String(node.type || '').toLowerCase();
  return Boolean(node.dispositionParameters?.filename || node.parameters?.name) && !type.startsWith('text/');
}
