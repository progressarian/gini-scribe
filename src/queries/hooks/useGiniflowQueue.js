import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import {
  COLUMN_ENTRY_STATUS,
  STATUS_LABEL,
  compareQueue,
  slaKeyForStatus,
} from "../../../shared/giniflowStatus";

const boardKey = (date) => ["giniflow", "board", date || "today"];

const TERMINAL_STATUSES = ["dispensed", "exited"];

// Every mutation here rewrites the board cache before the request leaves, then
// invalidates once it settles. The board polls on a 10s interval — without the
// optimistic write a dragged card visibly springs back to where it came from and
// then jumps again when the poll lands, which on a wall display reads as the
// board rejecting the move.
const patchBoard = (queryClient, date, fn) => {
  const key = boardKey(date);
  const previous = queryClient.getQueryData(key);
  if (previous) queryClient.setQueryData(key, fn(previous));
  return previous;
};

const restore = (queryClient, date, previous) => {
  if (previous) queryClient.setQueryData(boardKey(date), previous);
};

// Matches the board service: Done is a record rather than a queue, and the lab
// track runs on its own clock, so neither is sorted by compareQueue (BQ-04).
const resort = (column) =>
  column.key === "done" || column.key === "lab"
    ? column.cards
    : [...column.cards].sort(compareQueue);

const withCards = (column, cards) => ({
  ...column,
  cards: resort({ ...column, cards }),
  count: cards.length,
});

export function useGiniflowSetPriority(date) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, priority, reason }) =>
      (await api.patch(`/api/giniflow/visits/${visitId}/priority`, { priority, reason })).data,
    onMutate: async ({ visitId, priority, reason }) => {
      await queryClient.cancelQueries({ queryKey: boardKey(date) });
      return {
        previous: patchBoard(queryClient, date, (board) => ({
          ...board,
          columns: board.columns.map((col) =>
            withCards(
              col,
              col.cards.map((c) =>
                // A card whose priority changed loses its manual position: the
                // manager has just said something stronger about where it
                // belongs, and leaving the old position would pin an urgent
                // patient below the person they were meant to overtake.
                c.id === visitId
                  ? {
                      ...c,
                      priority,
                      priorityReason: priority === "normal" ? null : reason || null,
                      queuePosition: null,
                    }
                  : c,
              ),
            ),
          ),
        })),
      };
    },
    onError: (_e, _vars, ctx) => restore(queryClient, date, ctx?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] }),
  });
}

export function useGiniflowReorder(date) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ columnKey, visitIds }) =>
      (
        await api.patch(`/api/giniflow/columns/${columnKey}/order`, {
          visitIds,
          ...(date ? { date } : {}),
        })
      ).data,
    onMutate: async ({ columnKey, visitIds }) => {
      await queryClient.cancelQueries({ queryKey: boardKey(date) });
      const position = new Map(visitIds.map((id, i) => [id, i + 1]));
      return {
        previous: patchBoard(queryClient, date, (board) => ({
          ...board,
          columns: board.columns.map((col) =>
            col.key === columnKey
              ? withCards(
                  col,
                  col.cards.map((c) => ({ ...c, queuePosition: position.get(c.id) ?? null })),
                )
              : col,
          ),
        })),
      };
    },
    onError: (_e, _vars, ctx) => restore(queryClient, date, ctx?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] }),
  });
}

export function useGiniflowMove(date, slaConfig = []) {
  const queryClient = useQueryClient();
  const budgetFor = (status) =>
    slaConfig.find((c) => c.station === slaKeyForStatus(status))?.budgetMinutes ?? null;

  return useMutation({
    mutationFn: async ({ visitId, column }) =>
      (await api.post(`/api/giniflow/visits/${visitId}/move`, { column })).data,
    onMutate: async ({ visitId, column }) => {
      await queryClient.cancelQueries({ queryKey: boardKey(date) });
      const status = COLUMN_ENTRY_STATUS[column];
      return {
        previous: patchBoard(queryClient, date, (board) => {
          const moving = board.columns.flatMap((c) => c.cards).find((c) => c.id === visitId);
          if (!moving || !status) return board;
          // The patient has arrived somewhere new, so their station clock starts
          // now and is measured against the new station's budget. Anything less
          // would show the card carrying its old timer into the new column.
          const arrived = {
            ...moving,
            status,
            statusLabel: STATUS_LABEL[status] || status,
            statusSince: new Date().toISOString(),
            statusMinutes: 0,
            statusBudget: budgetFor(status),
            statusColour: "green",
            queuePosition: null,
            blockedReason: null,
            resumeStatus: null,
            // `dispensed` and `exited` both stop the clock; a drop on Done now
            // writes the former (BQ-03), so testing for exited alone would leave
            // the card ticking in the Done column.
            finished: TERMINAL_STATUSES.includes(status),
          };
          return {
            ...board,
            columns: board.columns.map((col) => {
              // A patient with an open lab order is rendered twice — once on the
              // chain, once on the parallel lab track. The lab copy stays in its
              // column, but it is the same patient and must not keep showing the
              // status they have just left (BQ-11).
              if (col.key === "lab") {
                return {
                  ...col,
                  cards: col.cards.map((c) => (c.id === visitId ? { ...c, ...arrived } : c)),
                };
              }
              if (col.key === column) return withCards(col, [...col.cards, arrived]);
              return withCards(
                col,
                col.cards.filter((c) => c.id !== visitId),
              );
            }),
          };
        }),
      };
    },
    onError: (_e, _vars, ctx) => restore(queryClient, date, ctx?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] }),
  });
}
