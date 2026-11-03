import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Group, Loader, Progress, Stack, Table, Text } from '@mantine/core';
import { IconCircleCheck, IconAlertTriangle } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import { formatTimestamp } from '../format';
import { QC_ANSWERS, type TripDetail, type TripQc } from '../types';
import { useCan } from '../permissions';

/** "QC passed" / "QC pending"; nothing for trips that don't need a check. */
export function QcBadge({ status, size = 'sm' }: { status: 'passed' | 'missing' | null | undefined; size?: 'xs' | 'sm' | 'md' }) {
  if (status === 'passed') {
    return (
      <Badge size={size} color="green" variant="light" leftSection={<IconCircleCheck size={12} />} style={{ minWidth: 'max-content' }}>
        QC passed
      </Badge>
    );
  }
  if (status === 'missing') {
    return (
      <Badge size={size} color="red" variant="filled" leftSection={<IconAlertTriangle size={12} />} style={{ minWidth: 'max-content' }}>
        QC pending
      </Badge>
    );
  }
  return null;
}

/** Loads the trip's checklist and shows it (for lists, where only the trip id is known). */
export function TripQualityCheck({ tripId }: { tripId: number }) {
  const { data } = useQuery({ queryKey: ['trip', String(tripId)], queryFn: () => api<TripDetail>(`/trips/${tripId}`) });
  if (!data) return <Loader size="sm" />;
  return <QualityChecklist tripId={tripId} qc={data.qc} />;
}

/**
 * The checklist: one answer per item (Verified / Not available / Not required;
 * click the chosen one again to clear it). Passes when every item has an answer.
 */
export function QualityChecklist({ tripId, qc }: { tripId: number; qc: TripQc }) {
  const mayEdit = useCan()('quality', 'edit');
  const saved = useMemo(() => Object.fromEntries(qc.items.map((i) => [i.id, i.answer])), [qc]);
  const [answers, setAnswers] = useState<Record<number, string | null>>(saved);
  useEffect(() => {
    setAnswers(saved);
  }, [saved]);

  const changed = qc.items.filter((i) => (answers[i.id] ?? null) !== (saved[i.id] ?? null));
  const answered = qc.items.filter((i) => answers[i.id]).length;

  const save = useMutation({
    mutationFn: () =>
      api<{ qc: TripQc }>(`/trips/${tripId}/qc`, {
        method: 'PUT',
        body: { answers: changed.map((i) => ({ item_id: i.id, answer: answers[i.id] ?? null })) },
      }),
    onSuccess: ({ qc: next }) => {
      queryClient.invalidateQueries({ queryKey: ['trip', String(tripId)] });
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      notifySuccess(next.status === 'passed' ? 'Quality check passed' : 'Quality check saved');
    },
    onError: notifyError,
  });

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <QcBadge status={qc.status} size="md" />
          {qc.status === 'passed' && (
            <Text size="sm">
              {qc.passed_by_name ? (
                <>
                  Passed by <b>{qc.passed_by_name}</b>
                  {qc.passed_at ? ` on ${formatTimestamp(qc.passed_at)}` : ''}
                </>
              ) : (
                'All items answered'
              )}
            </Text>
          )}
          {!qc.due && qc.status !== 'passed' && (
            <Text size="sm" c="dimmed">
              Not needed: the trip is over, inactive or cancelled.
            </Text>
          )}
        </Group>
        <Group gap="xs" w={220}>
          <Text size="xs" c="dimmed">
            {answered} of {qc.items.length} answered
          </Text>
          <Progress value={qc.items.length ? (answered / qc.items.length) * 100 : 100} color={answered === qc.items.length ? 'green' : 'orange'} style={{ flex: 1 }} />
        </Group>
      </Group>

      <Table.ScrollContainer minWidth={720}>
        <Table verticalSpacing="xs" striped>
          <Table.Tbody>
            {qc.items.map((item) => {
              const answer = answers[item.id] ?? null;
              return (
                <Table.Tr key={item.id}>
                  <Table.Td fw={500} w="30%">
                    {item.label}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      {QC_ANSWERS.map((a) => (
                        <Button
                          key={a.value}
                          size="compact-sm"
                          color={a.color}
                          variant={answer === a.value ? 'filled' : 'default'}
                          aria-pressed={answer === a.value}
                          onClick={() => setAnswers((all) => ({ ...all, [item.id]: answer === a.value ? null : a.value }))}
                        >
                          {a.label}
                        </Button>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {item.answer && item.answered_by_name ? (
                      <Text size="xs" c="dimmed">
                        {item.answered_by_name}
                        {item.answered_at ? `, ${formatTimestamp(item.answered_at)}` : ''}
                      </Text>
                    ) : !answer ? (
                      <Text size="xs" c="red">
                        Pending
                      </Text>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          Saving the trip or changing its bookings clears this check, so it is done again.
        </Text>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed.length || !mayEdit}>
          Save quality check
        </Button>
      </Group>
    </Stack>
  );
}
