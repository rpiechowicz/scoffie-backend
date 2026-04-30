import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

export type ShoppingAccumulator = {
  productKey: string;
  name: string;
  unit: string;
  department: string;
  totalAmount: number;
};

export type ShoppingListItem = ShoppingAccumulator & {
  isChecked: boolean;
};

export type ShoppingListArchiveSnapshot = {
  archiveId: string;
  weekStart: string;
  weekLabel: string;
  revision: number;
  archivedAt: number;
  isCurrentClosed: boolean;
  items: ShoppingListItem[];
};

export type ShoppingListStateDto = {
  items: ShoppingListItem[];
  archives: ShoppingListArchiveSnapshot[];
};

/// Lets methods accept either a transactional Prisma client or the root
/// PrismaService — useful for read paths that may run inside or outside a tx.
export type PrismaReadClient = Prisma.TransactionClient | PrismaService;
