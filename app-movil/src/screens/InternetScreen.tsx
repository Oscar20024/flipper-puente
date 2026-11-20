import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import React, { useEffect, useReducer, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';

import { BRIDGE_FAP_PATH } from '../bridge/InternetBridge';
import { useFlipper } from '../state/FlipperContext';
import { Button, Card, Muted, NotConnected, Row, Title, colors, styles } from '../ui/kit';

export function InternetScreen() {
  const { api, bridge } = useFlipper();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => bridge?.subscribe(rerender), [bridge]);

  if (!api || !bridge) return <NotConnected />;

  const guard = (fn: () => Promise<void>) => async () => {
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const installFap = guard(async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset.name.endsWith('.fap')) throw new Error('Elige el archivo internet_bridge.fap');
    await api.mkdir('/ext/apps').catch(() => undefined);
    await api.mkdir('/ext/apps/Tools').catch(() => undefined);
    await api.write(BRIDGE_FAP_PATH, await new File(asset.uri).bytes());
    setNotice('App instalada en el Flipper. Ya puedes abrir el puente.');
  });

  return (
    <View style={{ flex: 1, padding: 14, gap: 12 }}>
      <Card>
        <Title>Puente de internet</Title>
        <Muted>
          El Flipper no tiene Wi-Fi: la app "Puente Internet" del Flipper le pide las páginas al celular por Bluetooth y
          el celular las descarga con sus datos o Wi-Fi.
        </Muted>
        <Row>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: bridge.appRunning ? colors.ok : colors.muted }} />
          <Text style={{ color: colors.text }}>{bridge.appRunning ? 'Puente activo en el Flipper' : 'Puente cerrado'}</Text>
        </Row>
        <Row>
          <Button title="Abrir puente en el Flipper" onPress={guard(() => bridge.launch())} />
          <Button title="Cerrar" variant="secondary" onPress={guard(() => bridge.close())} />
        </Row>
        <Button small variant="secondary" title="Instalar/actualizar .fap desde el celular" onPress={installFap} />
        {notice && <Muted>{notice}</Muted>}
      </Card>

      <Card>
        <Title>Enviar mensaje a la pantalla del Flipper</Title>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Hola desde el celular"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        <Button
          small
          title="Enviar"
          disabled={!message || !bridge.appRunning}
          onPress={guard(async () => {
            await bridge.sendMessage(message);
            setMessage('');
          })}
        />
      </Card>

      <Title>Actividad</Title>
      <FlatList
        data={bridge.log}
        keyExtractor={(e) => String(e.id)}
        contentContainerStyle={{ gap: 6, paddingBottom: 30 }}
        ListEmptyComponent={<Muted>Sin actividad todavía.</Muted>}
        renderItem={({ item }) => (
          <Text style={[styles.mono, { color: item.direction === 'in' ? colors.accent : item.direction === 'out' ? colors.ok : colors.muted }]}>
            {item.time} {item.direction === 'in' ? '⬅' : item.direction === 'out' ? '➡' : '•'} {item.text}
          </Text>
        )}
      />
    </View>
  );
}
