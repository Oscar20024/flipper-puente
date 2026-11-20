import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { InternetBridge } from '../bridge/InternetBridge';
import { phoneHttpGet } from '../bridge/phoneHttpGet';
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
  /** Abrir el puente de internet automáticamente al conectar (igual que en la app de PC). */
  autoBridge: boolean;
  setAutoBridge: (on: boolean) => void;
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
  const [autoBridge, setAutoBridge] = useState(true);
  const rpcRef = useRef<RpcClient | null>(null);
  const bridgeRef = useRef<InternetBridge | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const autoBridgeRef = useRef(true);
  const checkingRef = useRef(false);
  const connectRef = useRef<(deviceId: string) => Promise<void>>(async () => undefined);

  useEffect(() => {
    autoBridgeRef.current = autoBridge;
  }, [autoBridge]);

  const reset = useCallback((error?: string) => {
    rpcRef.current = null;
    bridgeRef.current?.dispose();
    bridgeRef.current = null;
    setApi(null);
    setBridge(null);
    setStatus('disconnected');
    if (error) setLastError(error);
  }, []);

  /** Cierra una conexión trabada y vuelve a conectar al mismo Flipper. */
  const recover = useCallback(
    async (reason: string) => {
      const rpc = rpcRef.current;
      const id = deviceIdRef.current;
      bridgeRef.current?.note(reason);
      reset(reason);
      await Promise.race([rpc?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
      if (id) setTimeout(() => void connectRef.current(id).catch(() => undefined), 1500);
    },
    [reset],
  );

  /**
   * Una petición quedó sin respuesta. Si un ping corto tampoco responde, el
   * Flipper (o el Bluetooth) se trabó: cerrar todo y reconectar solo.
   */
  const checkHealth = useCallback(
    (rpc: RpcClient) => {
      // Mientras el Flipper espera que el usuario presione "Continuar", no responde: es normal.
      if (checkingRef.current || rpcRef.current !== rpc || bridgeRef.current?.launching) return;
      checkingRef.current = true;
      rpc
        .request({ systemPingRequest: { data: Uint8Array.from([7]) } }, 4000)
        .then(() => undefined)
        .catch(() => {
          if (rpcRef.current === rpc) void recover('El Flipper dejó de responder. Reconectando…');
        })
        .finally(() => {
          checkingRef.current = false;
        });
    },
    [recover],
  );

  const connect = useCallback(
    async (deviceId: string) => {
      setLastError(null);
      setStatus('connecting');
      try {
        const transport = await BleTransport.connect(deviceId);
        const rpc = new RpcClient(transport);
        const flipperApi = new FlipperApi(rpc);
        transport.onClose((reason) => {
          if (rpcRef.current !== rpc) return;
          reset(reason);
          // Se cortó el Bluetooth sin que el usuario desconectara: intentar volver una vez.
          const id = deviceIdRef.current;
          if (id) setTimeout(() => void connectRef.current(id).catch(() => undefined), 3000);
        });
        rpc.onTimeout(() => checkHealth(rpc));
        await flipperApi.ping(); // confirma que la sesión RPC responde
        const newBridge = new InternetBridge(flipperApi, phoneHttpGet);
        rpcRef.current = rpc;
        bridgeRef.current = newBridge;
        deviceIdRef.current = deviceId;
        setDeviceName(transport.name);
        setApi(flipperApi);
        setBridge(newBridge);
        setStatus('connected');
        // Igual que en la PC: abrir el puente solo (los errores quedan en la actividad del puente).
        if (autoBridgeRef.current) newBridge.launch().catch(() => undefined);
      } catch (e) {
        reset((e as Error).message);
        throw e;
      }
    },
    [reset, checkHealth],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(async () => {
    const rpc = rpcRef.current;
    deviceIdRef.current = null; // desconexión a mano: no reconectar solo
    reset();
    await Promise.race([rpc?.close(), new Promise((r) => setTimeout(r, 4000))]);
  }, [reset]);

  useEffect(() => () => void rpcRef.current?.close(), []);

  const value = useMemo(
    () => ({ status, deviceName, lastError, api, bridge, autoBridge, setAutoBridge, connect, disconnect }),
    [status, deviceName, lastError, api, bridge, autoBridge, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlipper(): FlipperState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFlipper debe usarse dentro de FlipperProvider');
  return ctx;
}
