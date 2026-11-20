import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';

import { useFlipper } from '../state/FlipperContext';
import {
  FoundFlipper,
  isBluetoothOn,
  requestBlePermissions,
  scanFlippers,
} from '../transport/BleTransport';
import { Button, Card, Muted, Row, Title, colors, styles } from '../ui/kit';

export function ConnectScreen() {
  const { status, deviceName, lastError, api, connect, disconnect } = useFlipper();
  const [found, setFound] = useState<FoundFlipper[]>([]);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<Record<string, string> | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const stopScan = () => {
    stopRef.current?.();
    stopRef.current = null;
    setScanning(false);
  };

  useEffect(() => stopScan, []);

  useEffect(() => {
    if (status !== 'connected' || !api) {
      setInfo(null);
      return;
    }
    Promise.all([api.deviceInfo(), api.powerInfo().catch(() => ({}) as Record<string, string>)])
      .then(([device, power]) => setInfo({ ...device, ...power }))
      .catch((e: Error) => setMessage(e.message));
  }, [status, api]);

  const startScan = async () => {
    setMessage(null);
    if (!(await requestBlePermissions())) {
      setMessage('Sin permiso de Bluetooth. Actívalo en los ajustes de la app.');
      return;
    }
    if (!(await isBluetoothOn())) {
      setMessage('Enciende el Bluetooth del celular.');
      return;
    }
    setFound([]);
    setScanning(true);
    stopRef.current = scanFlippers(
      (f) => setFound((prev) => [...prev, f]),
      (err) => {
        setMessage(err);
        stopScan();
      },
    );
    setTimeout(stopScan, 15000);
  };

  const onConnect = async (id: string) => {
    stopScan();
    setMessage('Conectando… si es la primera vez, acepta el PIN que aparece en el Flipper.');
    try {
      await connect(id);
      setMessage(null);
    } catch (e) {
      setMessage(`No se pudo conectar: ${(e as Error).message}`);
    }
  };

  if (status === 'connected') {
    const pick = (keys: string[]) => keys.map((k) => info?.[k]).find(Boolean);
    return (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Card>
          <Title>Conectado a {deviceName}</Title>
          <Muted>Sesión RPC activa por Bluetooth.</Muted>
          {info ? (
            <View style={{ gap: 4 }}>
              <InfoLine label="Nombre" value={pick(['hardware_name', 'hardware.name'])} />
              <InfoLine label="Firmware" value={pick(['firmware_version', 'firmware.version'])} />
              <InfoLine label="Rama" value={pick(['firmware_branch', 'firmware.branch.name'])} />
              <InfoLine label="Batería" value={pick(['charge_level', 'charge.level']) ? `${pick(['charge_level', 'charge.level'])} %` : undefined} />
              <InfoLine label="Protocolo RPC" value={pick(['protobuf_version_major', 'protobuf.version.major'])} />
            </View>
          ) : (
            <Muted>Leyendo información…</Muted>
          )}
          <Button title="Desconectar" variant="danger" onPress={disconnect} />
        </Card>
        {message && <Muted>{message}</Muted>}
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 14 }}>
      <Card>
        <Title>Conectar Flipper Zero</Title>
        <Muted>
          En el Flipper: Settings → Bluetooth → ON. Cierra la app oficial de Flipper en el celular si está
          conectada (solo una app puede usar el Bluetooth del Flipper a la vez).
        </Muted>
        <Button
          title={scanning ? 'Buscando…' : 'Buscar Flippers'}
          onPress={startScan}
          disabled={scanning || status === 'connecting'}
        />
        {status === 'connecting' && <Muted>Conectando…</Muted>}
        {(message || lastError) && <Text style={{ color: colors.danger }}>{message ?? lastError}</Text>}
      </Card>

      <FlatList
        data={found}
        keyExtractor={(d) => d.id}
        contentContainerStyle={{ gap: 10 }}
        ListEmptyComponent={scanning ? <Muted>Buscando dispositivos cercanos…</Muted> : undefined}
        renderItem={({ item }) => (
          <Pressable onPress={() => onConnect(item.id)} disabled={status === 'connecting'}>
            <Card>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.title}>{item.name}</Text>
                <Muted>{item.rssi != null ? `${item.rssi} dBm` : ''}</Muted>
              </Row>
              <Muted>Toca para conectar</Muted>
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

function InfoLine({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Muted>{label}</Muted>
      <Text style={{ color: colors.text }}>{value}</Text>
    </Row>
  );
}
