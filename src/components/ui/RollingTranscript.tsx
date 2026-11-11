import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

interface ChannelStatus {
    status: 'connected' | 'reconnecting' | 'failed' | 'awaiting-audio' | 'preparing';
    error?: string;
    provider?: string;
}

interface RollingTranscriptProps {
    text: string;
    isActive?: boolean;
    surfaceStyle?: React.CSSProperties;
    interviewerChannel?: ChannelStatus;
    microphoneChannel?: ChannelStatus;
}

export interface RollingTranscriptHandle {
    scrollByLines: (direction: -1 | 1) => boolean;
    scrollToBottom: () => void;
    isScrollable: () => boolean;
}

const TRANSCRIPT_SCROLL_LINES = 3;
const TRANSCRIPT_SCROLL_FRICTION_HALF_LIFE = 0.10;
const TRANSCRIPT_SCROLL_REPEAT_WINDOW_MS = 220;
const TRANSCRIPT_SCROLL_REPEAT_START_LINES_PER_SECOND = 36;
const TRANSCRIPT_SCROLL_TERMINAL_LINES_PER_SECOND = 72;
const TRANSCRIPT_SCROLL_MIN_VELOCITY = 6;
const TRANSCRIPT_SCROLL_MAX_FRAME_DT = 0.05;

const isNearBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 4;

const getTranscriptLineHeight = (el: HTMLElement) => {
    const textEl = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el;
    return Number.parseFloat(window.getComputedStyle(textEl).lineHeight) || 28;
};

const RollingTranscript = forwardRef<RollingTranscriptHandle, RollingTranscriptProps>(({
    text, isActive = true, surfaceStyle,
    interviewerChannel, microphoneChannel,
}, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const programmaticAutoScrollRef = useRef(false);
    const programmaticAutoScrollTimerRef = useRef<number | null>(null);
    const lastAutoScrolledTextRef = useRef<string | null>(null);
    const transcriptScrollMomentumRef = useRef({
        raf: null as number | null,
        lastTs: 0,
        velocity: 0,
        fraction: 0,
    });
    const lastTranscriptScrollCommandRef = useRef({
        ts: 0,
        direction: 0 as -1 | 0 | 1,
    });
    const [autoScroll, setAutoScroll] = useState(true);

    const intStatus = interviewerChannel?.status ?? 'connected';
    const micStatus = microphoneChannel?.status ?? 'connected';
    // Active/normal whenever at least one channel is connected and neither is failed or reconnecting.
    // A silent mic awaiting audio (e.g. listening through headphones/Bluetooth) must not block
    // system/interviewer transcript readiness.
    const isNormal = (intStatus === 'connected' || micStatus === 'connected')
        && intStatus !== 'failed'
        && micStatus !== 'failed'
        && intStatus !== 'reconnecting'
        && micStatus !== 'reconnecting';
    const showTranscriptText = intStatus !== 'failed' && micStatus !== 'failed';
    const preparingMessage = intStatus === 'preparing'
        ? interviewerChannel?.error
        : micStatus === 'preparing'
        ? microphoneChannel?.error
        : undefined;

    const setProgrammaticAutoScroll = useCallback((enabled: boolean) => {
        if (programmaticAutoScrollTimerRef.current !== null) {
            window.clearTimeout(programmaticAutoScrollTimerRef.current);
            programmaticAutoScrollTimerRef.current = null;
        }

        programmaticAutoScrollRef.current = enabled;
        if (enabled) {
            programmaticAutoScrollTimerRef.current = window.setTimeout(() => {
                programmaticAutoScrollRef.current = false;
                programmaticAutoScrollTimerRef.current = null;
            }, 500);
        }
    }, []);

    useEffect(() => {
        return () => {
            if (programmaticAutoScrollTimerRef.current !== null) {
                window.clearTimeout(programmaticAutoScrollTimerRef.current);
            }
            const momentum = transcriptScrollMomentumRef.current;
            if (momentum.raf !== null) {
                window.cancelAnimationFrame(momentum.raf);
                momentum.raf = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!showTranscriptText || !text) {
            lastAutoScrolledTextRef.current = null;
            return;
        }
        const el = containerRef.current;
        if (!el || !autoScroll) return;
        if (lastAutoScrolledTextRef.current === text) return;

        lastAutoScrolledTextRef.current = text;
        setProgrammaticAutoScroll(true);
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, [text, showTranscriptText, autoScroll, setProgrammaticAutoScroll]);

    useEffect(() => {
        const el = containerRef.current;
        const content = el?.firstElementChild;
        if (!el || !content || !autoScroll || !showTranscriptText) return;

        // Reflow can move the bottom without changing the transcript text.
        // Observe both the capped viewport and the text that wraps inside it.
        const observer = new ResizeObserver(() => {
            if (isNearBottom(el)) return;
            setProgrammaticAutoScroll(true);
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        });
        observer.observe(el);
        observer.observe(content);
        return () => observer.disconnect();
    }, [autoScroll, showTranscriptText, setProgrammaticAutoScroll]);

    const scrollToBottom = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
        setProgrammaticAutoScroll(false);
        setAutoScroll(true);
    }, [setProgrammaticAutoScroll]);

    const isScrollable = useCallback(() => {
        const el = containerRef.current;
        return Boolean(el && el.scrollHeight > el.clientHeight + 1);
    }, []);

    const stopTranscriptMomentum = useCallback(() => {
        const momentum = transcriptScrollMomentumRef.current;
        if (momentum.raf !== null) {
            window.cancelAnimationFrame(momentum.raf);
            momentum.raf = null;
        }
        momentum.lastTs = 0;
        momentum.velocity = 0;
        momentum.fraction = 0;
    }, []);

    const startTranscriptMomentum = useCallback(() => {
        const momentum = transcriptScrollMomentumRef.current;
        if (momentum.raf !== null) return;

        const tick = (ts: number) => {
            const el = containerRef.current;
            if (!el) {
                momentum.raf = null;
                momentum.lastTs = 0;
                momentum.velocity = 0;
                momentum.fraction = 0;
                return;
            }

            if (momentum.lastTs === 0) momentum.lastTs = ts;
            const dt = Math.min((ts - momentum.lastTs) / 1000, TRANSCRIPT_SCROLL_MAX_FRAME_DT);
            momentum.lastTs = ts;

            if (Math.abs(momentum.velocity) < TRANSCRIPT_SCROLL_MIN_VELOCITY) {
                momentum.raf = null;
                momentum.lastTs = 0;
                momentum.velocity = 0;
                momentum.fraction = 0;
                return;
            }

            const maxTop = el.scrollHeight - el.clientHeight;
            const current = el.scrollTop;
            const move = momentum.velocity * dt + momentum.fraction;
            const intMove = Math.trunc(move);
            momentum.fraction = move - intMove;

            if (intMove !== 0) {
                let nextTop = current + intMove;
                if (nextTop <= 0) {
                    nextTop = 0;
                    momentum.velocity = Math.max(0, momentum.velocity);
                    momentum.fraction = 0;
                } else if (nextTop >= maxTop) {
                    nextTop = maxTop;
                    momentum.velocity = Math.min(0, momentum.velocity);
                    momentum.fraction = 0;
                }

                if (nextTop !== current) el.scrollTop = nextTop;
                setAutoScroll(isNearBottom(el));
            }

            momentum.velocity *= Math.pow(0.5, dt / TRANSCRIPT_SCROLL_FRICTION_HALF_LIFE);
            momentum.raf = window.requestAnimationFrame(tick);
        };

        momentum.raf = window.requestAnimationFrame(tick);
    }, []);

    const scrollByLines = useCallback((direction: -1 | 1) => {
        const el = containerRef.current;
        if (!el || !isScrollable()) return false;

        const lineHeight = getTranscriptLineHeight(el);
        const maxTop = el.scrollHeight - el.clientHeight;
        if ((direction < 0 && el.scrollTop <= 1) || (direction > 0 && maxTop - el.scrollTop <= 1)) return false;

        const momentum = transcriptScrollMomentumRef.current;
        const command = lastTranscriptScrollCommandRef.current;
        const now = window.performance?.now?.() ?? Date.now();
        const isHeldRepeat = command.direction === direction && now - command.ts <= TRANSCRIPT_SCROLL_REPEAT_WINDOW_MS;
        command.ts = now;
        command.direction = direction;

        if (!isHeldRepeat) {
            stopTranscriptMomentum();
            const nextTop = Math.max(0, Math.min(maxTop, el.scrollTop + direction * lineHeight * TRANSCRIPT_SCROLL_LINES));
            if (Math.abs(nextTop - el.scrollTop) < 1) return false;

            setProgrammaticAutoScroll(false);
            el.scrollTop = nextTop;
            setAutoScroll(isNearBottom(el));
            return true;
        }

        if (Math.sign(momentum.velocity) === -direction) {
            momentum.velocity = 0;
            momentum.fraction = 0;
        }

        const kickVelocity = lineHeight * TRANSCRIPT_SCROLL_REPEAT_START_LINES_PER_SECOND;
        const minimumHeldVelocity = direction * lineHeight * TRANSCRIPT_SCROLL_REPEAT_START_LINES_PER_SECOND;
        const terminalVelocity = lineHeight * TRANSCRIPT_SCROLL_TERMINAL_LINES_PER_SECOND;
        momentum.velocity = Math.max(
            -terminalVelocity,
            Math.min(terminalVelocity, momentum.velocity + direction * kickVelocity),
        );
        if (Math.abs(momentum.velocity) < Math.abs(minimumHeldVelocity)) {
            momentum.velocity = minimumHeldVelocity;
        }

        setProgrammaticAutoScroll(false);
        setAutoScroll(false);
        startTranscriptMomentum();
        return true;
    }, [isScrollable, setProgrammaticAutoScroll, startTranscriptMomentum, stopTranscriptMomentum]);

    useImperativeHandle(ref, () => ({
        scrollByLines,
        scrollToBottom,
        isScrollable,
    }), [isScrollable, scrollByLines, scrollToBottom]);

    const interruptTranscriptScroll = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        stopTranscriptMomentum();
        setProgrammaticAutoScroll(false);
        // Cancel a pending smooth animation before native wheel/touch scrolling.
        el.scrollTop = el.scrollTop;
        setAutoScroll(isNearBottom(el));
    }, [setProgrammaticAutoScroll, stopTranscriptMomentum]);

    const handleScroll = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        if (programmaticAutoScrollRef.current) {
            if (isNearBottom(el)) setProgrammaticAutoScroll(false);
            else setProgrammaticAutoScroll(true);
            setAutoScroll(true);
            return;
        }
        setAutoScroll(isNearBottom(el));
    }, [setProgrammaticAutoScroll]);

    return (
        <div
            className="relative w-full px-4 py-1.5 z-20"
            hidden={!showTranscriptText || !text}
        >
            <div
                className="relative flex items-start gap-3 px-3.5 py-2.5 rounded-xl bg-slate-950/80 backdrop-blur-xl border border-white/15 shadow-xl shadow-black/35 transition-all duration-300"
                style={surfaceStyle}
            >
                {/* Live Indicator Badge */}
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5 px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-semibold uppercase tracking-wider select-none">
                    <span className="relative flex h-2 w-2">
                        {isActive && isNormal && (
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        )}
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    <span>Live</span>
                </div>

                {/* Three rendered lines, with manual scrolling independent of the chat. */}
                <div
                    ref={containerRef}
                    onScroll={handleScroll}
                    onWheel={interruptTranscriptScroll}
                    onTouchMove={interruptTranscriptScroll}
                    className="min-w-0 flex-1 max-h-[66px] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words overlay-transcript-surface text-left no-scrollbar"
                    style={{
                        scrollbarWidth: 'none',
                        maskImage: 'linear-gradient(to bottom, transparent 0px, black 8px, black 100%)',
                        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 8px, black 100%)',
                    }}
                >
                    <p className="text-[13.5px] font-medium text-slate-100/95 tracking-normal leading-[22px] drop-shadow-sm select-text m-0">
                        {showTranscriptText ? (text || preparingMessage || 'Listening…') : ''}
                    </p>
                </div>
            </div>
        </div>
    );
});

RollingTranscript.displayName = 'RollingTranscript';

export default RollingTranscript;
