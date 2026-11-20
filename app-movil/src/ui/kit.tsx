import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export const colors = {
  bg: '#121212',
  card: '#1E1E1E',
  border: '#2E2E2E',
  text: '#F2F2F2',
  muted: '#9A9A9A',
  accent: '#FF8200', // naranja Flipper
  danger: '#E5484D',
  ok: '#3DD68C',
};

type ButtonProps = {
  title: string;
  onPress: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
};

/** Botón que muestra un spinner mientras su acción asíncrona está corriendo. */
export function Button({ title, onPress, variant = 'primary', disabled, style, small }: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const bg = variant === 'primary' ? colors.accent : variant === 'danger' ? colors.danger : colors.border;
  const fg = variant === 'primary' ? '#000' : colors.text;
  return (
    <Pressable
      disabled={disabled || busy}
      onPress={async () => {
        setBusy(true);
        try {
          await onPress();
        } finally {
          setBusy(false);
        }
      }}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function NotConnected() {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>Sin Flipper conectado</Text>
      <Muted>Ve a la pestaña "Conectar" y empareja tu Flipper por Bluetooth.</Muted>
    </View>
  );
}

type PromptProps = {
  visible: boolean;
  title: string;
  initial?: string;
  placeholder?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
};

export function PromptModal({ visible, title, initial = '', placeholder, onCancel, onSubmit }: PromptProps) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial, visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <Card style={styles.modalCard}>
          <Title>{title}</Title>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.muted}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button title="Cancelar" variant="secondary" small onPress={onCancel} />
            <Button title="Aceptar" small onPress={() => onSubmit(value.trim())} disabled={!value.trim()} />
          </Row>
        </Card>
      </View>
    </Modal>
  );
}

export const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  buttonSmall: { paddingVertical: 8, paddingHorizontal: 12, minHeight: 38 },
  buttonText: { fontWeight: '700', fontSize: 15 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  input: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  modalBackdrop: { flex: 1, backgroundColor: '#000A', justifyContent: 'center', padding: 20 },
  modalCard: { gap: 14 },
  mono: { fontFamily: 'monospace', color: colors.text, fontSize: 12 },
});
