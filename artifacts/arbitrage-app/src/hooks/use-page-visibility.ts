import { useState, useEffect, useRef } from "react";

export interface PageVisibilityResult {
  isVisible: boolean;
  absenceSeconds: number | null;
}

export function usePageVisibility(): PageVisibilityResult {
  const [isVisible, setIsVisible] = useState(
    typeof document !== "undefined" ? document.visibilityState === "visible" : true
  );
  const [absenceSeconds, setAbsenceSeconds] = useState<number | null>(null);
  const hiddenAtRef = useRef<number | null>(null);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        setAbsenceSeconds(null);
        setIsVisible(false);
      } else {
        if (hiddenAtRef.current !== null) {
          const elapsed = Math.round((Date.now() - hiddenAtRef.current) / 1000);
          setAbsenceSeconds(elapsed);
          hiddenAtRef.current = null;
        }
        setIsVisible(true);
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return { isVisible, absenceSeconds };
}
