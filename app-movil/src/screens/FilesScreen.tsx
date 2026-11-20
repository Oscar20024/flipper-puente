import { Buffer } from 'buffer';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { FlipperApi, FlipperFile, joinPath, parentPath } from '../rpc/FlipperApi';
import { useFlipper } from '../state/FlipperContext';
import { Button, Card, Muted, NotConnected, PromptModal, Row, Title, colors, styles } from '../ui/kit';

const ROOTS = ['/ext', '/int'];
const MAX_EDIT_BYTES = 64 * 1024;

type PromptState =
  | { kind: 'mkdir' }
  | { kind: 'rename'; file: FlipperFile }
  | null;

export function FilesScreen() {
  const { api } = useFlipper();
  if (!api) return <NotConnected />;
  return <FileBrowser api={api} />;
}

function FileBrowser({ api }: { api: FlipperApi }) {
  const [path, setPath] = useState('/ext');
  const [files, setFiles] = useState<FlipperFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FlipperFile | null>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [editor, setEditor] = useState<{ path: string; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFiles(await api.list(path));
    } catch (e) {
      setError((e as Error).message);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [api, path]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setProgress(label);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const openFile = (file: FlipperFile) => {
    if (file.isDir) setPath(joinPath(path, file.name));
    else setSelected(file);
  };

  const editFile = (file: FlipperFile) =>
    run('Leyendo archivo…', async () => {
      if (file.size > MAX_EDIT_BYTES) throw new Error('El archivo es muy grande para editarlo aquí.');
      const full = joinPath(path, file.name);
      const data = await api.read(full);
      setSelected(null);
      setEditor({ path: full, text: Buffer.from(data).toString('utf8') });
    });

  const shareFile = (file: FlipperFile) =>
    run('Descargando del Flipper…', async () => {
      const data = await api.read(joinPath(path, file.name));
      const local = new File(Paths.cache, file.name);
      if (local.exists) local.delete();
      local.create();
      await local.write(data);
      setSelected(null);
      await Sharing.shareAsync(local.uri, { dialogTitle: file.name });
    });

  const deleteEntry = (file: FlipperFile) => {
    Alert.alert('Eliminar', `¿Eliminar "${file.name}"${file.isDir ? ' y todo su contenido' : ''}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: () =>
          run('Eliminando…', async () => {
            await api.remove(joinPath(path, file.name), true);
            setSelected(null);
            await refresh();
          }),
      },
    ]);
  };

  const uploadFiles = () =>
    run('Subiendo…', async () => {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      for (const [i, asset] of result.assets.entries()) {
        setProgress(`Subiendo ${i + 1}/${result.assets.length}: ${asset.name}`);
        const bytes = await new File(asset.uri).bytes();
        await api.write(joinPath(path, asset.name), bytes);
      }
      await refresh();
    });

  const downloadFolder = (file: FlipperFile) =>
    run('Copiando carpeta al celular…', async () => {
      const base = new Directory(Paths.document, 'FlipperDescargas');
      if (!base.exists) base.create();
      const target = new Directory(base, file.name);
      if (target.exists) target.delete();
      target.create();
      const count = await copyFolder(api, joinPath(path, file.name), target, (name) =>
        setProgress(`Copiando ${name}…`),
      );
      setSelected(null);
      Alert.alert('Listo', `${count} archivos copiados en la carpeta de la app:\nFlipperDescargas/${file.name}`);
    });

  const onPromptSubmit = (value: string) => {
    const current = prompt;
    setPrompt(null);
    if (!current) return;
    if (current.kind === 'mkdir') {
      run('Creando carpeta…', async () => {
        await api.mkdir(joinPath(path, value));
        await refresh();
      });
    } else {
      run('Renombrando…', async () => {
        await api.rename(joinPath(path, current.file.name), joinPath(path, value));
        setSelected(null);
        await refresh();
      });
    }
  };

  const isRoot = ROOTS.includes(path);

  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <Row>
        {ROOTS.map((r) => (
          <Button
            key={r}
            small
            title={r === '/ext' ? 'Tarjeta SD' : 'Interno'}
            variant={path.startsWith(r) ? 'primary' : 'secondary'}
            onPress={() => setPath(r)}
          />
        ))}
      </Row>
      <Row>
        <Button small variant="secondary" title="⬆ Subir nivel" disabled={isRoot} onPress={() => setPath(parentPath(path))} />
        <Text style={[styles.mono, { flex: 1 }]} numberOfLines={1}>
          {path}
        </Text>
      </Row>
      <Row>
        <Button small title="Subir archivos" onPress={uploadFiles} />
        <Button small variant="secondary" title="Nueva carpeta" onPress={() => setPrompt({ kind: 'mkdir' })} />
        <Button small variant="secondary" title="Refrescar" onPress={refresh} />
      </Row>
      {progress && <Muted>{progress}</Muted>}
      {error && <Text style={{ color: colors.danger }}>{error}</Text>}

      <FlatList
        data={files}
        keyExtractor={(f) => f.name}
        refreshing={loading}
        onRefresh={refresh}
        contentContainerStyle={{ gap: 6, paddingBottom: 40 }}
        ListEmptyComponent={!loading ? <Muted>Carpeta vacía</Muted> : undefined}
        renderItem={({ item }) => (
          <Pressable onPress={() => openFile(item)} onLongPress={() => setSelected(item)}>
            <View style={[styles.card, { paddingVertical: 10 }]}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={{ color: colors.text, fontSize: 15, flex: 1 }} numberOfLines={1}>
                  {item.isDir ? '📁 ' : '📄 '}
                  {item.name}
                </Text>
                {!item.isDir && <Muted>{formatSize(item.size)}</Muted>}
                {item.isDir && (
                  <Pressable onPress={() => setSelected(item)} hitSlop={10}>
                    <Text style={{ color: colors.accent, fontSize: 18 }}>⋯</Text>
                  </Pressable>
                )}
              </Row>
            </View>
          </Pressable>
        )}
      />

      {/* Acciones sobre un archivo o carpeta */}
      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <View style={styles.modalBackdrop}>
          {selected && (
            <Card style={styles.modalCard}>
              <Title>{selected.name}</Title>
              <Muted>{selected.isDir ? 'Carpeta' : formatSize(selected.size)}</Muted>
              {!selected.isDir && <Button title="Ver / editar texto" onPress={() => editFile(selected)} />}
              {!selected.isDir && <Button title="Compartir / guardar en el celular" variant="secondary" onPress={() => shareFile(selected)} />}
              {selected.isDir && <Button title="Abrir" onPress={() => { setSelected(null); openFile(selected); }} />}
              {selected.isDir && <Button title="Copiar carpeta al celular" variant="secondary" onPress={() => downloadFolder(selected)} />}
              <Button title="Renombrar" variant="secondary" onPress={() => setPrompt({ kind: 'rename', file: selected })} />
              <Button title="Eliminar" variant="danger" onPress={() => deleteEntry(selected)} />
              <Button title="Cerrar" variant="secondary" onPress={() => setSelected(null)} />
              {progress && <Muted>{progress}</Muted>}
            </Card>
          )}
        </View>
      </Modal>

      <PromptModal
        visible={!!prompt}
        title={prompt?.kind === 'mkdir' ? 'Nombre de la carpeta' : 'Nuevo nombre'}
        initial={prompt?.kind === 'rename' ? prompt.file.name : ''}
        onCancel={() => setPrompt(null)}
        onSubmit={onPromptSubmit}
      />

      {/* Editor de texto */}
      <Modal visible={!!editor} animationType="slide" onRequestClose={() => setEditor(null)}>
        {editor && (
          <View style={{ flex: 1, backgroundColor: colors.bg, padding: 12, gap: 10 }}>
            <Text style={styles.mono} numberOfLines={1}>
              {editor.path}
            </Text>
            <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
              <TextInput
                multiline
                value={editor.text}
                onChangeText={(text) => setEditor({ ...editor, text })}
                style={[styles.input, styles.mono, { minHeight: 400, textAlignVertical: 'top' }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </ScrollView>
            <Row>
              <Button title="Cancelar" variant="secondary" onPress={() => setEditor(null)} />
              <Button
                title="Guardar en el Flipper"
                onPress={() =>
                  run('Guardando…', async () => {
                    await api.write(editor.path, new Uint8Array(Buffer.from(editor.text, 'utf8')));
                    setEditor(null);
                    await refresh();
                  })
                }
              />
            </Row>
          </View>
        )}
      </Modal>
    </View>
  );
}

async function copyFolder(
  api: FlipperApi,
  remote: string,
  local: Directory,
  onFile: (name: string) => void,
): Promise<number> {
  let count = 0;
  for (const entry of await api.list(remote)) {
    const remotePath = joinPath(remote, entry.name);
    if (entry.isDir) {
      const sub = new Directory(local, entry.name);
      sub.create();
      count += await copyFolder(api, remotePath, sub, onFile);
    } else {
      onFile(entry.name);
      const file = new File(local, entry.name);
      file.create();
      await file.write(await api.read(remotePath));
      count++;
    }
  }
  return count;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
