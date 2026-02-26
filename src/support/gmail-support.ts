/**
 * Gmail client for support-triage: OAuth from env (GMAIL_CLIENT_ID, _SECRET, _REFRESH_TOKEN).
 * Lists unread threads, fetches thread content, archives threads.
 * Outgoing replies: AI markdown draft → HTML (marked) + optional custom-email-footer → text/html (multipart/alternative with text/plain fallback).
 */
import fs from 'fs';
import path from 'path';

import { marked } from 'marked';
import { google, gmail_v1 } from 'googleapis';

import {
  BRAIN_PATH,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
} from './config.js';
import { logger } from '../logger.js';

const KB_DIR = 'knowledge-base';
const DEFAULT_PLAIN_FOOTER = '\n\n---\nHandled by AutoSupportClaw — 24/7 autonomous support 🦞';
const DEFAULT_HTML_FOOTER =
  '<p style="margin-top:1em;border-top:1px solid #eee;padding-top:0.5em;color:#666;font-size:0.9em;">Handled by AutoSupportClaw — 24/7 autonomous support 🦞</p>';

export interface ThreadMessage {
  from: string;
  subject: string;
  date: string;
  body: string;
  messageId: string;
}

export interface SupportThread {
  threadId: string;
  subject: string;
  messages: ThreadMessage[];
}

function extractTextBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      const text = extractTextBody(part);
      if (text) return text;
    }
  }
  return '';
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return '';
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return (h?.value as string) || '';
}

/** Load custom-email-footer: prefer .html, else .md (converted to HTML). Returns { html, plain } for multipart. */
function loadEmailFooter(): { html: string; plain: string } {
  const kbRoot = path.join(BRAIN_PATH, KB_DIR);
  const htmlPath = path.join(kbRoot, 'custom-email-footer.html');
  const mdPath = path.join(kbRoot, 'custom-email-footer.md');
  try {
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf-8').trim();
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { html, plain: plain || DEFAULT_PLAIN_FOOTER };
    }
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, 'utf-8').trim();
      if (md.length > 0 && !md.startsWith('<!--')) {
        const html = marked.parse(md, { async: false }) as string;
        return { html, plain: md };
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Could not load custom-email-footer, using default');
  }
  return { html: DEFAULT_HTML_FOOTER, plain: DEFAULT_PLAIN_FOOTER };
}

/** Convert AI markdown draft to HTML for the email body. */
function markdownToHtml(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';
  const html = marked.parse(trimmed, { async: false }) as string;
  return html.trim();
}

export async function createGmailClient(): Promise<gmail_v1.Gmail | null> {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    logger.warn('Gmail env (GMAIL_CLIENT_ID, _SECRET, _REFRESH_TOKEN) missing');
    return null;
  }

  const oauth2 = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob',
  );
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    logger.info(
      { email: profile.data.emailAddress },
      'Gmail support client connected',
    );
    return gmail;
  } catch (err) {
    logger.error({ err }, 'Gmail auth failed');
    return null;
  }
}

/** List unread thread IDs (inbox, primary). */
export async function listUnreadThreadIds(
  gmail: gmail_v1.Gmail,
  maxResults = 20,
): Promise<string[]> {
  const res = await gmail.users.threads.list({
    userId: 'me',
    q: 'is:unread in:inbox',
    maxResults,
  });
  const threads = res.data.threads || [];
  return threads.map((t) => t.id!).filter(Boolean);
}

/** Fetch full thread: subject and all messages (from, date, body). */
export async function getThread(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<SupportThread | null> {
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });
  const thread = res.data;
  const messages = (thread.messages || []).sort(
    (a, b) =>
      parseInt(a.internalDate || '0', 10) - parseInt(b.internalDate || '0', 10),
  );
  let subject = '';
  const out: ThreadMessage[] = [];
  for (const msg of messages) {
    const headers = msg.payload?.headers || [];
    const from = getHeader(headers, 'From');
    const subj = getHeader(headers, 'Subject');
    if (subj) subject = subj;
    const date = getHeader(headers, 'Date');
    const messageId = getHeader(headers, 'Message-ID');
    const body = extractTextBody(msg.payload);
    out.push({
      from,
      subject: subj,
      date,
      body,
      messageId,
    });
  }
  if (!subject && out.length > 0) subject = out[0].subject || '(no subject)';
  return { threadId, subject, messages: out };
}

/** Archive thread (remove from INBOX) and optionally remove UNREAD. */
export async function archiveThread(
  gmail: gmail_v1.Gmail,
  threadId: string,
  markRead = true,
): Promise<void> {
  const removeLabelIds = ['INBOX', ...(markRead ? ['UNREAD'] : [])];
  await gmail.users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { removeLabelIds },
  });
  logger.info({ threadId }, 'Thread archived');
}

/**
 * Send a reply in the given thread from the authenticated support account.
 * Converts the AI's markdown body to HTML, appends the HTML footer, and sends multipart/alternative (plain + html).
 */
export async function sendReply(
  gmail: gmail_v1.Gmail,
  thread: SupportThread,
  body: string,
): Promise<boolean> {
  if (thread.messages.length === 0) {
    logger.warn({ threadId: thread.threadId }, 'Cannot send reply: no messages in thread');
    return false;
  }
  const last = thread.messages[thread.messages.length - 1];
  const to = last.from;
  const subject = thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`;
  const inReplyTo = last.messageId || '';
  const references = last.messageId || '';

  let fromEmail: string;
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    fromEmail = profile.data.emailAddress || 'support@autosupportclaw.com';
  } catch (err) {
    logger.error({ err }, 'Failed to get Gmail profile for From address');
    return false;
  }

  const footer = loadEmailFooter();
  const plainBody = body.trim() + footer.plain;
  const htmlBody =
    '<div style="font-family: sans-serif; max-width: 640px;">' +
    markdownToHtml(body) +
    footer.html +
    '</div>';

  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const crlf = '\r\n';
  const plainPart = [
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(plainBody, 'utf-8').toString('base64'),
  ].join(crlf);
  const htmlPart = [
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(htmlBody, 'utf-8').toString('base64'),
  ].join(crlf);
  const multipartBody = [
    `--${boundary}`,
    plainPart,
    `--${boundary}`,
    htmlPart,
    `--${boundary}--`,
  ].join(crlf);

  const headers = [
    `To: ${to}`,
    `From: ${fromEmail}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    multipartBody,
  ].join(crlf);

  const raw = Buffer.from(headers, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: thread.threadId,
      },
    });
    logger.info({ threadId: thread.threadId, to }, 'Gmail reply sent from support address');
    return true;
  } catch (err) {
    logger.error({ err, threadId: thread.threadId }, 'Failed to send Gmail reply');
    return false;
  }
}
