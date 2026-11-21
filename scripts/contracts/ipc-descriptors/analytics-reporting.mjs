// Family 8: analytics-reporting (5 commands)

import { d } from '../descriptor-dsl.mjs';

const INVENTORY_CURSOR_PATTERN = '^[A-Za-z0-9_-]{1,512}$';
const REPORT_CURSOR_MAX = 512;

export const ANALYTICS_REPORTING_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_READ_METRICS',
    interfaceName: 'ReadMetricsCommand',
    validatorName: 'validateReadMetrics',
    family: 'analytics-reporting',
    doc: 'Scan workspace audit/rollup metrics with optional archive inclusion and bounded runIds filter.',
    payloadMode: 'required',
    payload: d.obj(
      {
        includeArchives: d.field(d.bool({ err: 'invalid-payload-field' }), { optional: true }),
        runIds: d.field(
          d.ref('ReadMetricsRunIdList', {
            tsType: 'readonly string[]',
            predicate: {
              fn: 'isReadMetricsRunIdList',
              importFrom: '../../sidebar-ipc',
              err: 'invalid-payload-field'
            },
            jsonSchema: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 256 }
            }
          }),
          { optional: true }
        )
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_READ_STORAGE_DETAILS',
    interfaceName: 'ReadStorageDetailsCommand',
    validatorName: 'validateReadStorageDetails',
    family: 'analytics-reporting',
    doc: 'Read storage pressure summary and one paginated artifact inventory page.',
    payloadMode: 'required',
    payload: d.obj({
      cursor: d.field(
        d.str({ minLen: 1, maxLen: 512, pattern: INVENTORY_CURSOR_PATTERN, err: 'invalid-cursor' }),
        { optional: true }
      )
    })
  }),

  d.command({
    type: 'CMD_READ_USAGE_ACCOUNTING',
    interfaceName: 'ReadUsageAccountingCommand',
    validatorName: 'validateReadUsageAccounting',
    family: 'analytics-reporting',
    doc: 'Read one usage accounting page; query validation is delegated to the shared host validator.',
    payloadMode: 'required',
    payload: d.obj({
      query: d.field(d.unknown({ presenceErr: 'missing-query' }), { presenceOnly: true })
    })
  }),

  d.command({
    type: 'CMD_READ_REPORT',
    interfaceName: 'ReadReportCommand',
    validatorName: 'validateReadReport',
    family: 'analytics-reporting',
    doc: 'Run, page, drill down, cancel, list, or reproduce historical reports.',
    payloadMode: 'required',
    payload: d.discUnion(
      'op',
      {
        run: d.obj({
          op: d.lit('run'),
          query: d.field(d.unknown({ presenceErr: 'missing-query' }), { presenceOnly: true })
        }),
        page: d.obj({
          op: d.lit('page'),
          cursor: d.str({ minLen: 1, maxLen: REPORT_CURSOR_MAX, err: 'invalid-cursor' })
        }),
        drillDown: d.obj({
          op: d.lit('drillDown'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' }),
          rootId: d.str({ format: 'safePathSegment', err: 'invalid-rootId' })
        }),
        close: d.obj({
          op: d.lit('close'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' })
        }),
        rerunSaved: d.obj({
          op: d.lit('rerunSaved'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' })
        }),
        reproduceSaved: d.obj({
          op: d.lit('reproduceSaved'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' })
        }),
        listSaved: d.obj({
          op: d.lit('listSaved'),
          request: d.field(d.unknown(), { optional: true })
        }),
        cancelActive: d.obj({
          op: d.lit('cancelActive')
        })
      },
      { missingDiscErr: 'missing-op', invalidDiscErr: 'invalid-op' }
    )
  }),

  d.command({
    type: 'CMD_MUTATE_REPORT',
    interfaceName: 'MutateReportCommand',
    validatorName: 'validateMutateReport',
    family: 'analytics-reporting',
    doc: 'Export (via host dialog), save, or delete a saved report record.',
    payloadMode: 'required',
    payload: d.discUnion(
      'op',
      {
        export: d.obj({
          op: d.lit('export'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' }),
          format: d.enum(['json', 'csv'], { err: 'invalid-format' })
        }),
        save: d.obj({
          op: d.lit('save'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' })
        }),
        deleteSaved: d.obj({
          op: d.lit('deleteSaved'),
          reportId: d.str({ format: 'safePathSegment', err: 'invalid-reportId' }),
          confirmed: d.lit(true, { err: 'missing-confirmation' })
        })
      },
      { missingDiscErr: 'missing-op', invalidDiscErr: 'invalid-op' }
    )
  })
]);
