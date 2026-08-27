import {useEffect, useState} from 'react';
import {prootController} from '../services/prootController';
import type {ContainerState} from '../types';

/** 轮询容器状态；原生模块不可用时回退为 stopped。 */
export function useContainerStatus() {
  const [containerState, setContainerState] = useState<ContainerState>('stopped');

  useEffect(() => {
    const refresh = () =>
      prootController
        .status()
        .then(value => setContainerState(value as ContainerState))
        .catch(() => setContainerState('stopped'));
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  return {containerState, setContainerState};
}
