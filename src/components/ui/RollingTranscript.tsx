import React, { useEffect, useRef, useState } from 'react';

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

const RollingTranscript: React.FC<RollingTranscriptProps> = ({
    text,
    isActive = true,
    surfaceStyle,
    interviewerChannel,
    microphoneChannel,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isHovered, setIsHovered] = useState(false);

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

    useEffect(() => {
        if (!isHovered && containerRef.current && showTranscriptText && text) {
            containerRef.current.scrollTo({
                top: containerRef.current.scrollHeight,
                behavior: 'smooth',
            });
        }
    }, [text, showTranscriptText, isHovered]);

    if (!showTranscriptText || !text) return null;

    return (
        <div 
            className="relative w-full px-4 py-1.5 z-20"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
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

                {/* Multiline Text Box (2-3 lines with smooth vertical roll) */}
                <div
                    ref={containerRef}
                    className="flex-1 max-h-[50px] overflow-y-auto whitespace-normal break-words scroll-smooth text-left no-scrollbar"
                    style={{
                        maskImage: 'linear-gradient(to bottom, transparent 0%, black 14%, black 100%)',
                        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 14%, black 100%)',
                    }}
                >
                    <p className="text-[13.5px] font-medium text-slate-100/95 tracking-normal leading-[22px] drop-shadow-sm select-text m-0">
                        {text || preparingMessage || 'Listening…'}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default RollingTranscript;
