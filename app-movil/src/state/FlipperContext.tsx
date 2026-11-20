import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { InternetBridge } from '../bridge/InternetBridge';
import { FlipperApi } from '../rpc/FlipperApi';
import { RpcClient } from '../rpc/RpcClient';
import { BleTransport } from '../transport/BleTransport';

type Status = 'disconnected' | 'connecting' | 'connected';

type FlipperState = {
  status: Status;
  deviceName: string | null;
  lastError: string | null;
  api: FlipperApi | null;
  bridge: InternetBridge | null;
  connect: (deviceId: string) => Promise<void>;
  disconnect: () => Promise<void>;
};

const Ctx = createContext<FlipperState | null>(null);

export function FlipperProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('disconnected');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [api, setApi] = useState<FlipperApi | null>(null);
  const [bridge, setBridge] = useState<InternetBridge | null>(null);
  const rpcRef = useRef<RpcClient | null>(null);

  const reset = useCallback((error?: string) => {
    rpcRef.current = null;
    setApi(null);
    setBridge((b) => {
      b?.dispose();
      return null;
    });
    setStatus('disconnected');
    if (error) setLastError(error);
  }, []);

  const connect = useCallback(
    async (deviceId: string) => {
      setLastError(null);
      setStatus('connecting');
      try {
        const transport = await BleTransport.connect(deviceId);
        const rpc = new RpcClient(transport);
        const flipperApi = new FlipperApi(rpc);
        transport.onClose((reason) => reset(reason));
        await flipperApi.ping(); // confirma que la sesión RPC responde
        rpcRef.current = rpc;
        setDeviceName(transport.name);
        setApi(flipperApi);
        setBridge(new InternetBridge(flipperApi));
        setStatus('connected');
      } catch (e) {
        reset((e as Error).message);
        throw e;
      }
    },
    [reset],
  );

  const disconnect = useCallback(async () => {
    const rpc = rpcRef.current;
    reset();
    await rpc?.close();
  }, [reset]);

  useEffect(() => () => void rpcRef.current?.close(), []);

  const value = useMemo(
    () => ({ status, deviceName, lastError, api, bridge, connect, disconnect }),
    [status, deviceName, lastError, api, bridge, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlipper(): FlipperState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFlipper debe usarse dentro de FlipperProvider');
  return ctx;
}
