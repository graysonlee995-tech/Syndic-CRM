import { Button, Group, Image, Modal, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { documentLabel, type ClientDocument } from '../types';
import { PdfPages } from './PdfPages';

export function DocumentViewer({ document, onClose }: { document: ClientDocument | null; onClose: () => void }) {
  const src = document ? `/api/documents/${document.id}/file` : '';
  return (
    <Modal
      opened={Boolean(document)}
      onClose={onClose}
      size="80rem"
      title={
        document && (
          <Group gap="xs">
            <Text fw={600}>{documentLabel(document.type)}</Text>
            <Text c="dimmed">{document.document_number}</Text>
          </Group>
        )
      }
    >
      {document && (
        <>
          {document.mime_type === 'application/pdf' ? (
            <PdfPages src={src} />
          ) : (
            <Image src={src} alt={documentLabel(document.type)} fit="contain" mah="75vh" />
          )}
          <Group justify="flex-end" mt="sm">
            <Button component="a" href={`${src}?download=1`} variant="light" leftSection={<IconDownload size={16} />}>
              Download
            </Button>
          </Group>
        </>
      )}
    </Modal>
  );
}
