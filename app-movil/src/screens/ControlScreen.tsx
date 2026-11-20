import React, { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, Text, TextInput, View } from 'react-native';

import type { InputKey } from '../rpc/FlipperApi';
import { useFlipper } from '../state/FlipperContext';
import { Button, Card, Muted, NotConnected, Row, Title, colors, styles } from '../ui/kit';
import { frameToBmpUri } from '../ui/screenFrame';

/** Nombres de apps integradas que el loader del firmware oficial reconoce. */
const APP_PRESETS = ['Sub-GHz', 'NFC', '125 kHz RFID', 'Infrared', 'iButton', 'GPIO', 'U2F'];

export function ControlScreen() {
  const { api } = useFlipper();
  const [frame, setFrame] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [appName, setAppName] = useState('');
  const [output, setOutput] = useState<string>('');

  useEffect(() => {
    if (!api) return;
    return api.rpc.onUnsolicited((msg) => {
      if (msg.content === 'guiScreenFrame' && msg.guiScreenFrame?.data) {
        setFrame(frameToBmpUri(msg.guiScreenFrame.data));
      }
    });
  }, [api]);

  useEffect(() => {
    // Al salir de la pantalla, detener la transmisión.
    return () => {
      if (streaming) api?.stopScreenStream().catch(() => undefined);
    };
  }, [api, streaming]);

  if (!api) return <NotConnected />;

  const show = (title: string, data: unknown) =>
    setOutput(`${title}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);

  const guard = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      show('Error', (e as Error).message);
    }
  };

  const toggleStream = guard(async () => {
    if (streaming) {
      await api.stopScreenStream();
      setStreaming(false);
    } else {
      await api.startScreenStream();
      setStreaming(true);
    }
  });

  const press = (key: InputKey, long = false) => guard(() => api.pressButton(key, long));

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 40 }}>
      <Card>
        <Title>Pantalla y control remoto</Title>
        <View style={{ aspectRatio: 2, backgroundColor: '#FF8200', borderRadius: 8, overflow: 'hidden' }}>
          {frame ? (
            <Image source={{ uri: frame }} style={{ width: '100%', height: '100%' }} resizeMode="stretch" />
          ) : (
            <View style={styles.center}>
              <Text style={{ color: '#000' }}>Toca "Ver pantalla"</Text>
            </View>
          )}
        </View>
        <Button title={streaming ? 'Dejar de ver pantalla' : 'Ver pantalla'} variant="secondary" onPress={toggleStream} />
        <View style={{ alignItems: 'center', gap: 6 }}>
          <Button small title="▲" onPress={press('UP')} style={{ width: 70 }} />
          <Row style={{ justifyContent: 'center' }}>
            <Button small title="◀" onPress={press('LEFT')} style={{ width: 70 }} />
            <Button small title="OK" onPress={press('OK')} style={{ width: 70 }} />
            <Button small title="▶" onPress={press('RIGHT')} style={{ width: 70 }} />
          </Row>
          <Row style={{ justifyContent: 'center' }}>
            <Button small title="▼" onPress={press('DOWN')} style={{ width: 70 }} />
            <Button small variant="secondary" title="Atrás" onPress={press('BACK')} style={{ width: 80 }} />
            <Button small variant="secondary" title="OK largo" onPress={press('OK', true)} style={{ width: 90 }} />
          </Row>
        </View>
      </Card>

      <Card>
        <Title>Comandos</Title>
        <Row>
          <Button small title="Ping" onPress={guard(async () => show('Ping', `${await api.ping()} ms`))} />
          <Button small title="Info" onPress={guard(async () => show('Información del dispositivo', await api.deviceInfo()))} />
          <Button small title="Batería" onPress={guard(async () => show('Energía', await api.powerInfo()))} />
          <Button
            small
            title="Espacio SD"
            onPress={guard(async () => {
              const { total, free } = await api.storageInfo('/ext');
              show('Tarjeta SD', `Libre: ${(free / 1048576).toFixed(1)} MB de ${(total / 1048576).toFixed(1)} MB`);
            })}
          />
          <Button small title="Sincronizar hora" onPress={guard(async () => { await api.syncDateTime(); show('Hora', 'Hora del Flipper = hora del celular'); })} />
          <Button small title="Alerta (LED + vibrar)" onPress={guard(async () => { await api.playAlert(); show('Alerta', 'Enviada'); })} />
          <Button
            small
            variant="danger"
            title="Reiniciar"
            onPress={() =>
              Alert.alert('Reiniciar Flipper', 'Se cortará la conexión Bluetooth.', [
                { text: 'Cancelar', style: 'cancel' },
                { text: 'Reiniciar', style: 'destructive', onPress: () => api.reboot('OS') },
              ])
            }
          />
        </Row>
      </Card>

      <Card>
        <Title>Abrir apps del Flipper</Title>
        <Muted>Nombre de una app integrada o la ruta de un .fap (por ejemplo /ext/apps/Tools/mi_app.fap).</Muted>
        <Row>
          {APP_PRESETS.map((name) => (
            <Button key={name} small variant="secondary" title={name} onPress={() => setAppName(name)} />
          ))}
        </Row>
        <TextInput
          value={appName}
          onChangeText={setAppName}
          placeholder="Nombre o ruta"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          style={styles.input}
        />
        <Row>
          <Button small title="Abrir" disabled={!appName} onPress={guard(async () => { await api.appStart(appName.trim()); show('App', `Abierta: ${appName}`); })} />
          <Button small variant="secondary" title="Cerrar app actual" onPress={guard(async () => { await api.appExit(); show('App', 'Cerrada'); })} />
        </Row>
      </Card>

      {output ? (
        <Card>
          <Text style={styles.mono}>{output}</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}
