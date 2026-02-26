/**
 * Gmail client for support-triage: OAuth from env (GMAIL_CLIENT_ID, _SECRET, _REFRESH_TOKEN).
 * Lists unread threads, fetches thread content, archives threads.
 */
import { google, gmail_v1 } from 'googleapis';

import {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
} from './config.js';
import { logger } from '../logger.js';

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
 * Uses thread's last message for To, In-Reply-To, References; subject as Re: <subject>.
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

  const headers = [
    `To: ${to}`,
    `From: ${fromEmail}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

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
