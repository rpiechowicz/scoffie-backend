import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type { AgentReport, ReportStatus } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import { usdOf } from './profit-math';
import {
  buildReportScenario,
  type ReportScenarioResult,
} from './report-scenario';
import {
  answeringModel,
  reportReasonOf,
  reportStatusOf,
  reportTurnStatusOf,
} from './report-view';

/** Kolejka pokazuje najnowsze zgłoszenia; starsze zostają w bazie. */
export const REPORTS_LIMIT = 200;

const reportNotFound = () =>
  new AppException(
    'NOT_FOUND',
    'Nie znaleziono zgłoszenia.',
    HttpStatus.NOT_FOUND,
  );

/**
 * Zgłoszenia odpowiedzi asystenta (ROADMAPA §5.5) — kolejka, decyzja
 * moderatora i zamiana w scenariusz benchmarku.
 *
 * Treść: WYŁĄCZNIE migawka `messageText`, którą użytkownik sam wysłał do
 * rozpatrzenia (ROADMAPA §1.4). Rozmowy, z której pochodzi, panel nie czyta —
 * z tury bierze tylko metadane (model, koszt, czas, status, kod błędu).
 *
 * Zapis statusu idzie prosto przez Prismę: kolumny decyzji (`status`,
 * `reviewedAt`, `reviewedByAdminId`) należą do panelu, a domena asystenta nie
 * ma dla nich serwisu — `AgentReportsService` tylko przyjmuje zgłoszenia.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  list(): Promise<AgentReport[]> {
    return readOnlyQuery(this.prisma, async (tx) => {
      const reports = await tx.agentReport.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: REPORTS_LIMIT,
        select: {
          id: true,
          userId: true,
          reason: true,
          comment: true,
          messageText: true,
          createdAt: true,
          status: true,
          turnId: true,
          user: { select: { displayName: true } },
        },
      });
      const turnIds = [
        ...new Set(
          reports
            .map((report) => report.turnId)
            .filter((id): id is string => id !== null),
        ),
      ];
      // Tura skasowana retencją (90 dni) albo z rozmową usuniętą przez
      // użytkownika po prostu się nie znajdzie — karta pokaże wtedy `turn: null`.
      const turns =
        turnIds.length > 0
          ? await tx.agentTurn.findMany({
              where: { id: { in: turnIds } },
              select: {
                id: true,
                model: true,
                status: true,
                errorCode: true,
                durationMs: true,
              },
            })
          : [];
      const phases =
        turnIds.length > 0
          ? await tx.aiUsage.groupBy({
              by: ['turnId', 'model'],
              where: { turnId: { in: turnIds } },
              _sum: { costMicroUsd: true },
            })
          : [];
      const phasesByTurn = new Map<
        string,
        { model: string; costMicroUsd: number }[]
      >();
      for (const phase of phases) {
        if (!phase.turnId) continue;
        const list = phasesByTurn.get(phase.turnId) ?? [];
        list.push({
          model: phase.model,
          costMicroUsd: phase._sum.costMicroUsd ?? 0,
        });
        phasesByTurn.set(phase.turnId, list);
      }
      const turnsById = new Map(turns.map((turn) => [turn.id, turn]));

      return reports.map((report): AgentReport => {
        const turn = report.turnId ? turnsById.get(report.turnId) : undefined;
        const turnPhases = turn ? (phasesByTurn.get(turn.id) ?? []) : [];
        return {
          id: report.id,
          userId: report.userId,
          userName: report.user.displayName,
          reason: reportReasonOf(report.reason),
          comment: report.comment,
          messageText: report.messageText,
          createdAt: report.createdAt.toISOString(),
          turn: turn
            ? {
                model: answeringModel(turn.model, turnPhases),
                // Koszt z księgi `AiUsage` (wszystkie fazy tury), nie z
                // `AgentTurn.costMicroUsd` — księga to dane rozliczeniowe.
                costUsd: usdOf(
                  turnPhases.reduce(
                    (sum, phase) => sum + phase.costMicroUsd,
                    0,
                  ),
                ),
                // Tura bez czasu (nikt jej nie domknął) — 0 zamiast zgadywania.
                durationMs: turn.durationMs ?? 0,
                status: reportTurnStatusOf(turn.status),
                errorCode: turn.errorCode,
              }
            : null,
          status: reportStatusOf(report.status),
          // Scenariusz nie zostawia śladu w bazie (produkcja nie ma gita,
          // a kolumny na identyfikator testu nie ma) — `testId` wraca tylko
          // w odpowiedzi `POST …/scenario`.
          testId: null,
        };
      });
    });
  }

  /**
   * Decyzja moderatora. Powrót do `NEW` czyści, kto i kiedy rozpatrzył —
   * zgłoszenie wraca do kolejki jak nowe; ślad zostaje w dzienniku audytu.
   */
  async setStatus(
    actor: AdminActor,
    id: string,
    status: ReportStatus,
  ): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'report.status.set',
        targetType: 'AgentReport',
        targetId: id,
        details: { to: status },
      },
      () =>
        this.prisma.$transaction(async (tx) => {
          const current = await tx.agentReport.findUnique({
            where: { id },
            select: { status: true },
          });
          if (!current) throw reportNotFound();
          const reviewed = status !== 'NEW';
          await tx.agentReport.update({
            where: { id },
            data: {
              status,
              reviewedAt: reviewed ? new Date() : null,
              reviewedByAdminId: reviewed ? actor.adminUserId : null,
            },
          });
          return { from: current.status, to: status };
        }),
      (result) => result,
    );
  }

  /** Szkic scenariusza `pnpm agent:scenarios` ze zgłoszenia — bez zapisu. */
  scenario(actor: AdminActor, id: string): Promise<ReportScenarioResult> {
    return this.audit.run(
      actor,
      {
        action: 'report.scenario',
        targetType: 'AgentReport',
        targetId: id,
      },
      async () => {
        const source = await readOnlyQuery(this.prisma, async (tx) => {
          const report = await tx.agentReport.findUnique({
            where: { id },
            select: {
              id: true,
              reason: true,
              comment: true,
              messageText: true,
              createdAt: true,
              turnId: true,
            },
          });
          if (!report) return null;
          const turn = report.turnId
            ? await tx.agentTurn.findUnique({
                where: { id: report.turnId },
                select: { model: true },
              })
            : null;
          const phases = report.turnId
            ? await tx.aiUsage.groupBy({
                by: ['model'],
                where: { turnId: report.turnId },
                _sum: { costMicroUsd: true },
              })
            : [];
          return {
            report,
            model: turn
              ? answeringModel(
                  turn.model,
                  phases.map((phase) => ({
                    model: phase.model,
                    costMicroUsd: phase._sum.costMicroUsd ?? 0,
                  })),
                ) || null
              : null,
          };
        });
        if (!source) throw reportNotFound();
        return buildReportScenario({
          id: source.report.id,
          reason: reportReasonOf(source.report.reason),
          comment: source.report.comment,
          messageText: source.report.messageText,
          createdAt: source.report.createdAt,
          model: source.model,
        });
      },
      (result) => ({ testId: result.testId, group: result.scenario.group }),
    );
  }
}
