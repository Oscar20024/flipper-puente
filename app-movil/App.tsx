import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { Pressable, StatusBar as RNStatusBar, Text, View } from 'react-native';

import { ConnectScreen } from './src/screens/ConnectScreen';
import { ControlScreen } from './src/screens/ControlScreen';
import { FilesScreen } from './src/screens/FilesScreen';
import { InternetScreen } from './src/screens/InternetScreen';
import { FlipperProvider, useFlipper } from './src/state/FlipperContext';
import { colors } from './src/ui/kit';

const TABS = [
  { key: 'connect', label: 'Conectar', icon: '📡', Screen: ConnectScreen },
  { key: 'files', label: 'Archivos', icon: '🗂', Screen: FilesScreen },
  { key: 'control', label: 'Comandos', icon: '🎮', Screen: ControlScreen },
  { key: 'internet', label: 'Internet', icon: '🌐', Screen: InternetScreen },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function Shell() {
  const [tab, setTab] = useState<TabKey>('connect');
  const { status, deviceName } = useFlipper();
  const Active = TABS.find((t) => t.key === tab)!.Screen;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: RNStatusBar.currentHeight ?? 24 }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: colors.accent, fontSize: 20, fontWeight: '800', flex: 1 }}>Flipper Puente</Text>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: status === 'connected' ? colors.ok : status === 'connecting' ? colors.accent : colors.muted,
          }}
        />
        <Text style={{ color: colors.muted }}>{status === 'connected' ? deviceName : status === 'connecting' ? 'Conectando…' : 'Desconectado'}</Text>
      </View>

      <View style={{ flex: 1 }}>
        <Active />
      </View>

      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card }}>
        {TABS.map((t) => (
          <Pressable key={t.key} onPress={() => setTab(t.key)} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, paddingBottom: 18 }}>
            <Text style={{ fontSize: 18 }}>{t.icon}</Text>
            <Text style={{ color: tab === t.key ? colors.accent : colors.muted, fontSize: 12, fontWeight: '600' }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return (
    <FlipperProvider>
      <Shell />
    </FlipperProvider>
  );
}
