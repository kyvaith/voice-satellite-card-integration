const END_CONVERSATION_PATTERNS = [
  /\b(to wszystko|wystarczy|dziekuje to wszystko|dzieki to wszystko)\b/,
  /\b(dziekuje koniec|dzieki koniec|ok koniec|okej koniec|dobra koniec)\b/,
  /\b(koniec rozmowy|konczymy rozmowe|zakoncz rozmowe|zakonczmy rozmowe)\b/,
  /\b(przestan sluchac|nie sluchaj|nie nasluchuj)\b/,
  /\b(that is all|that's all|thanks that's all|thank you that's all)\b/,
  /\b(end conversation|stop listening|we are done|goodbye|bye for now)\b/,
  /\b(milego dnia|do uslyszenia|do zobaczenia|na razie)\b/,
  /\b(have a nice day|talk to you later|see you later)\b/,
];
const SHORT_END_CONVERSATION_PATTERN =
  /^(?:ok|okej|dobra|no|dziekuje|dzieki|thanks|thank you)?\s*(?:koniec|wystarczy|goodbye|bye)\s*$/;

export function normalizeTranscriptText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%\u2026)\]}])/g, '$1')
    .replace(/([,.;:!?])(?=\p{L}|\p{N})/gu, '$1 ')
    .replace(/([([{])\s+/g, '$1')
    .trim();
}

function compactTranscript(value) {
  return normalizeTranscriptText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function transcriptOverlapSize(existing, incoming) {
  const max = Math.min(existing.length, incoming.length, 160);
  const existingLower = existing.toLocaleLowerCase();
  const incomingLower = incoming.toLocaleLowerCase();
  for (let length = max; length > 0; length -= 1) {
    if (existingLower.slice(-length) === incomingLower.slice(0, length)) return length;
  }
  return 0;
}

function transcriptJoiner(existing, incoming, rawIncoming) {
  if (!existing || !incoming) return '';
  if (/^\s/.test(String(rawIncoming || ''))) return ' ';
  if (/^[,.;:!?%\u2026)\]}]/.test(incoming)) return '';
  if (/[(\[{]$/.test(existing)) return '';
  if (/[-/\u2013\u2014]$/.test(existing) || /^[-/\u2013\u2014]/.test(incoming)) return '';
  return ' ';
}

export function mergeTranscript(existing, chunk) {
  const current = normalizeTranscriptText(existing);
  const rawText = String(chunk || '');
  const text = normalizeTranscriptText(rawText);
  if (!text) return current;
  if (!current) return text;

  const currentCompact = compactTranscript(current);
  const textCompact = compactTranscript(text);
  if (!textCompact) return current;
  if (textCompact === currentCompact) return current;
  if (textCompact.startsWith(currentCompact) && text.length >= current.length) return text;

  const currentTail = compactTranscript(current.slice(-320));
  if (textCompact.length > 3 && currentTail.includes(textCompact)) return current;

  const overlap = transcriptOverlapSize(current, text);
  if (overlap > 0) return normalizeTranscriptText(`${current}${text.slice(overlap)}`);

  return normalizeTranscriptText(`${current}${transcriptJoiner(current, text, rawText)}${text}`);
}

function transcriptWords(value) {
  return normalizeTranscriptText(value)
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2);
}

function transcriptWordSimilarity(left, right) {
  const leftWords = new Set(transcriptWords(left));
  const rightWords = new Set(transcriptWords(right));
  if (!leftWords.size || !rightWords.size) return 0;
  let matched = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) matched += 1;
  }
  return matched / Math.min(leftWords.size, rightWords.size);
}

function fragmentedTranscriptScore(value) {
  return normalizeTranscriptText(value)
    .split(/\s+/)
    .filter((part) => /^\p{L}$/u.test(part))
    .length;
}

function hasTerminalTranscriptPunctuation(text) {
  return /[.!?]\s*$/.test(normalizeTranscriptText(text));
}

function isLikelyTranscriptReplacement(existing, incoming) {
  const current = normalizeTranscriptText(existing);
  const text = normalizeTranscriptText(incoming);
  if (!current || !text) return false;
  const currentCompact = compactTranscript(current);
  const textCompact = compactTranscript(text);
  if (textCompact === currentCompact) return true;
  if (textCompact.startsWith(currentCompact) && text.length >= current.length) return true;
  if (currentCompact.includes(textCompact) && textCompact.length < currentCompact.length * 0.72) return false;

  const similarity = transcriptWordSimilarity(current, text);
  const currentFragmented = fragmentedTranscriptScore(current);
  const incomingFragmented = fragmentedTranscriptScore(text);
  if (hasTerminalTranscriptPunctuation(text) && similarity >= 0.52 && text.length >= current.length * 0.55) return true;
  if (currentFragmented >= incomingFragmented + 2 && similarity >= 0.4) return true;
  return similarity >= 0.72 && text.length >= current.length * 0.75 && incomingFragmented <= currentFragmented;
}

function isTranscriptFragment(text, reference) {
  const incoming = compactTranscript(text);
  const existing = compactTranscript(reference);
  if (!incoming || !existing || incoming.length > existing.length) return false;
  if (existing.includes(incoming)) return true;
  const incomingWords = transcriptWords(text);
  if (incoming.length > 12 || incomingWords.length !== 1) return false;
  return transcriptWords(reference)
    .map((word) => compactTranscript(word))
    .some((word) => word && (word.startsWith(incoming) || incoming.startsWith(word)));
}

export function mergeDisplayTurnText(existing, incoming) {
  const current = normalizeTranscriptText(existing);
  const text = normalizeTranscriptText(incoming);
  if (!text) return current;
  if (!current || isLikelyTranscriptReplacement(current, text)) return text;
  if (isTranscriptFragment(text, current)) return current;
  return mergeTranscript(current, text);
}

function transcriptTokenParts(value) {
  const text = normalizeTranscriptText(value);
  return [...text.matchAll(/\p{L}[\p{L}\p{N}]*/gu)]
    .map((match) => ({
      text: match[0],
      compact: compactTranscript(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((token) => token.compact);
}

export function removeTranscriptEchoSpan(text, reference) {
  const cleanText = normalizeTranscriptText(text);
  const refTokens = transcriptTokenParts(reference);
  const tokens = transcriptTokenParts(cleanText);
  if (refTokens.length < 2 || tokens.length < 2) return cleanText;

  let best = null;
  for (let start = 0; start < tokens.length; start += 1) {
    let length = 0;
    while (
      start + length < tokens.length
      && length < refTokens.length
      && tokens[start + length].compact === refTokens[length].compact
    ) {
      length += 1;
    }
    const enough = length >= Math.min(3, refTokens.length) || (refTokens.length === 2 && length === 2);
    if (enough && length / refTokens.length >= 0.62 && (!best || length > best.length)) {
      best = { start, length };
    }
  }

  if (!best) return cleanText;
  const first = tokens[best.start];
  const last = tokens[best.start + best.length - 1];
  return normalizeTranscriptText(`${cleanText.slice(0, first.start)} ${cleanText.slice(last.end)}`);
}

export function isLikelyTranscriptEcho(text, reference) {
  const incoming = compactTranscript(text);
  const existing = compactTranscript(reference);
  if (incoming.length < 6 || existing.length < 6) return false;
  if (existing.includes(incoming)) return true;

  const incomingWords = transcriptWords(text);
  if (incomingWords.length < 2) return false;
  const existingWords = new Set(transcriptWords(reference));
  const matched = incomingWords.filter((word) => existingWords.has(word)).length;
  return matched >= 2 && matched / incomingWords.length >= 0.75;
}

export function mergeAssistantTurnText(existing, incoming, priority, currentPriority) {
  const current = normalizeTranscriptText(existing);
  const text = normalizeTranscriptText(incoming);
  if (!text) return current;
  if (!current) return text;

  if (hasTerminalTranscriptPunctuation(current) && isTranscriptFragment(text, current)) return current;
  if (priority > currentPriority) {
    if (isTranscriptFragment(text, current) && !isLikelyTranscriptReplacement(current, text)) return current;
    return text;
  }
  if (isLikelyTranscriptReplacement(current, text)) return text;
  return mergeTranscript(current, text);
}

export function shouldEndConversation(text) {
  const clean = String(text || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return false;
  return SHORT_END_CONVERSATION_PATTERN.test(clean)
    || END_CONVERSATION_PATTERNS.some((pattern) => pattern.test(clean));
}
