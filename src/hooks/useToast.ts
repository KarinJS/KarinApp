import {useCallback, useEffect, useRef, useState} from 'react';

const NOTICE_DURATION_MS = 2400;

export function useToast() {
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    setNotice(message);
    timer.current = setTimeout(() => {
      setNotice(current => (current === message ? '' : current));
      timer.current = null;
    }, NOTICE_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return {notice, showNotice};
}
