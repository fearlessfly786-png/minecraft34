'use client';

/**
 * LOBBY AI — the two AI boxes on the lobby command deck:
 *
 *   <AiCommandBox />  — "AI COMMAND": chat with SARGE, the game-aware
 *                       command AI (POST /api/ai/assistant).
 *   <AiMissionBox />  — "AI MISSIONS": one-click daily bounty generator
 *                       (POST /api/ai/mission) with accept + history.
 *
 * Both are self-contained (fetch + local state) and render INSIDE a
 * LobbyBox crate, so they only ship content — the crate chrome lives in
 * the lobby screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Coins,
  Dices,
  Gem,
  LoaderCircle,
  Send,
  Target,
} from 'lucide-react';

type ChatMsg = { role: 'user' | 'assistant'; content: string };

const QUICK_ASKS = [
  'How do I win?',
  'Best weapon?',
  'Crafting basics?',
] as const;

const SARGE_GREETING: ChatMsg = {
  role: 'assistant',
  content:
    'SARGE on the line. Ask me anything — weapons, zones, crafting, tactics. I keep the answers short, soldier.',
};

/** ==== AI COMMAND — SARGE chat ========================================= */
export function AiCommandBox() {
  const [messages, setMessages] = useState<ChatMsg[]>([SARGE_GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** Keep the newest message in view. */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim().slice(0, 300);
      if (!text || busy) return;
      const nextMessages: ChatMsg[] = [...messages, { role: 'user', content: text }];
      setMessages(nextMessages);
      setInput('');
      setBusy(true);
      try {
        const res = await fetch('/api/ai/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: nextMessages.slice(-10),
          }),
        });
        const data = (await res.json()) as { ok: boolean; reply?: string; error?: string };
        if (data.ok && data.reply) {
          setMessages((msgs) => [...msgs, { role: 'assistant', content: data.reply! }]);
        } else {
          setMessages((msgs) => [
            ...msgs,
            {
              role: 'assistant',
              content: data.error ?? 'Radio static — say that again?',
            },
          ]);
        }
      } catch {
        setMessages((msgs) => [
          ...msgs,
          { role: 'assistant', content: 'Uplink failed — check the connection and try again.' },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, messages]
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* transcript */}
      <div
        ref={scrollRef}
        role="log"
        aria-label="SARGE conversation"
        aria-live="polite"
        className="ratfire-scroll flex max-h-56 min-h-40 flex-col gap-1.5 overflow-y-auto pr-1"
      >
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex items-start gap-1.5 ${
              msg.role === 'user' ? 'flex-row-reverse' : ''
            }`}
          >
            <span
              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border ${
                msg.role === 'user'
                  ? 'border-amber-400/50 bg-amber-400/10'
                  : 'border-emerald-400/50 bg-emerald-400/10'
              }`}
            >
              {msg.role === 'user' ? (
                <Target className="h-3 w-3 text-amber-300" aria-hidden />
              ) : (
                <Bot className="h-3 w-3 text-emerald-300" aria-hidden />
              )}
            </span>
            <p
              className={`max-w-[85%] border px-2 py-1 text-[10px] font-semibold leading-snug ${
                msg.role === 'user'
                  ? 'border-amber-400/30 bg-amber-400/5 text-amber-100'
                  : 'border-zinc-700/70 bg-zinc-950/70 text-zinc-200'
              }`}
            >
              {msg.content}
            </p>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.25em] text-emerald-300">
            <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
            SARGE is typing…
          </div>
        )}
      </div>

      {/* quick asks */}
      <div className="flex flex-wrap gap-1">
        {QUICK_ASKS.map((ask) => (
          <button
            key={ask}
            type="button"
            disabled={busy}
            onClick={() => void send(ask)}
            className="border border-zinc-700/70 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-zinc-400 transition-colors hover:border-emerald-400/60 hover:text-emerald-300 disabled:opacity-40"
          >
            {ask}
          </button>
        ))}
      </div>

      {/* composer */}
      <form
        className="mt-auto flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask SARGE — tactics, weapons, crafting…"
          aria-label="Message SARGE"
          maxLength={300}
          className="min-w-0 flex-1 border border-zinc-700 bg-zinc-900/80 px-2 py-1.5 text-[11px] font-semibold text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-400/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          aria-label="Send message to SARGE"
          className="grid h-8 w-8 shrink-0 place-items-center border border-emerald-400/50 bg-emerald-400/10 text-emerald-300 transition-colors hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </div>
  );
}

/** ==== AI MISSIONS — one-click bounty generator ======================== */
type Mission = {
  title: string;
  zone: string;
  difficulty: string;
  objective: string;
  brief: string;
  hint: string;
  rewardCoins: number;
  rewardGems: number;
};

const DIFF_STYLES: Record<string, string> = {
  RECRUIT: 'border-emerald-400/50 text-emerald-300',
  VETERAN: 'border-amber-400/50 text-amber-300',
  ELITE: 'border-red-500/60 text-red-400',
};

export function AiMissionBox({
  showToast,
}: {
  showToast: (message: string) => void;
}) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const generate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/ai/mission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { ok: boolean; mission?: Mission };
      if (data.ok && data.mission) {
        setMission(data.mission);
        setAccepted(false);
        setHistory((list) => [data.mission!.title, ...list].slice(0, 4));
      } else {
        showToast('MISSION UPLINK FAILED — try again');
      }
    } catch {
      showToast('MISSION UPLINK FAILED — try again');
    } finally {
      setBusy(false);
    }
  }, [busy, showToast]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <button
        type="button"
        onClick={() => void generate()}
        disabled={busy}
        className="flex h-9 items-center justify-center gap-2 border border-emerald-400/70 bg-gradient-to-b from-emerald-400/25 to-teal-600/25 text-[11px] font-black uppercase tracking-[0.2em] text-emerald-100 transition-colors hover:from-emerald-400/40 hover:to-teal-600/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Dices className="h-4 w-4" aria-hidden />
        )}
        {busy ? 'Drafting the bounty…' : 'Generate AI mission'}
      </button>

      {mission ? (
        <div
          className={`ratfire-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto border p-2 ${
            accepted
              ? 'border-emerald-400/60 bg-emerald-400/5'
              : 'border-zinc-800 bg-zinc-950/50'
          }`}
          role="article"
          aria-label={`Mission ${mission.title}`}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.2em] ${
                DIFF_STYLES[mission.difficulty] ??
                'border-zinc-600 text-zinc-300'
              }`}
            >
              {mission.difficulty}
            </span>
            <span className="border border-zinc-600 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.2em] text-zinc-300">
              {mission.zone}
            </span>
            {accepted && (
              <span className="ml-auto flex items-center gap-1 text-[8px] font-black uppercase tracking-[0.2em] text-emerald-300">
                <span
                  className="h-1 w-1 animate-pulse rounded-full bg-emerald-400"
                  aria-hidden
                />
                Active
              </span>
            )}
          </div>
          <p className="text-[11px] font-black uppercase tracking-[0.15em] text-zinc-100">
            {mission.title}
          </p>
          <p className="text-[10px] font-bold leading-snug text-amber-200/90">
            {mission.objective}
          </p>
          <p className="text-[10px] font-semibold leading-snug text-zinc-400">
            {mission.brief}
          </p>
          <p className="border-t border-zinc-800 pt-1.5 text-[9px] font-semibold italic leading-snug text-zinc-500">
            Intel: {mission.hint}
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <span className="flex items-center gap-1 text-[10px] font-black tabular-nums text-amber-300">
              <Coins className="h-3.5 w-3.5" aria-hidden />+{mission.rewardCoins}
            </span>
            <span className="flex items-center gap-1 text-[10px] font-black tabular-nums text-emerald-300">
              <Gem className="h-3.5 w-3.5" aria-hidden />+{mission.rewardGems}
            </span>
            <button
              type="button"
              disabled={accepted}
              onClick={() => {
                setAccepted(true);
                showToast(`MISSION ACCEPTED · ${mission.title.toUpperCase()}`);
              }}
              className="ml-auto border border-amber-400/60 bg-amber-400/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-amber-300 transition-colors hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:border-emerald-400/40 disabled:bg-transparent disabled:text-emerald-300"
            >
              {accepted ? 'In the log' : 'Accept'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-24 flex-1 flex-col items-center justify-center border border-dashed border-zinc-800 p-2 text-center">
          <Bot className="mb-1 h-4 w-4 text-zinc-600" aria-hidden />
          <p className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-600">
            No bounty yet — roll one
          </p>
        </div>
      )}

      {history.length > 1 && (
        <p className="truncate text-[8px] font-bold uppercase tracking-[0.2em] text-zinc-600">
          Earlier rolls: {history.slice(1).join(' · ')}
        </p>
      )}
    </div>
  );
}
