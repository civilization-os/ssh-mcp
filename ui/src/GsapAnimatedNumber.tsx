import { useRef, useEffect } from "react";
import gsap from "gsap";

export interface GsapAnimatedNumberProps {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  ease?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * High-performance smooth numeric tween powered by GSAP.
 * Directly updates DOM textContent without causing React state re-render thrashing.
 */
export function GsapAnimatedNumber({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 0.55,
  ease = "power2.out",
  className,
  style,
}: GsapAnimatedNumberProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const currentValRef = useRef<{ val: number }>({ val: Number.isFinite(value) ? value : 0 });

  useEffect(() => {
    const obj = currentValRef.current;
    const target = Number.isFinite(value) ? value : 0;

    const tween = gsap.to(obj, {
      val: target,
      duration,
      ease,
      onUpdate: () => {
        if (spanRef.current) {
          spanRef.current.textContent = `${prefix}${obj.val.toFixed(decimals)}${suffix}`;
        }
      },
    });

    return () => {
      tween.kill();
    };
  }, [value, decimals, prefix, suffix, duration, ease]);

  const initialSafe = Number.isFinite(value) ? value : 0;

  return (
    <span ref={spanRef} className={className} style={style}>
      {`${prefix}${initialSafe.toFixed(decimals)}${suffix}`}
    </span>
  );
}
