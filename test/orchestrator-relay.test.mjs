import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { temp, project, fakeClis } from './helpers.mjs';
import { ELU_CALLS_PER_DAY, OVERSEE_DENIED, SERVER_NAME, TOOL_NAME, overseeing, serve } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals, readApprovalLog } from '../lib/approvals.mjs';
import { approvalServer } from '../lib/mcp.mjs';
import { saveRule } from '../lib/permission-rules.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { saveTask } from '../lib/state.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { actionsFile } from '../lib/orchestrator-actions.mjs';
import { ORCH_TOOLS, overseeingAnswer, readingTool } from '../lib/orchestrator-tools.mjs';

// The approval relay for the turn of the bot that oversees the sessions (--oversee,
// lib/approval-server.mjs): its own table answers first, in every mode and before any rule of
// the owner's, it is served its ten tools, and its questions to ELU have a cap a day. Driven in
// process with PassThrough pipes, as test/approval-server.test.mjs does; ELU's own folder is a
// new empty one in every test. No model or vendor program is started: one test runs turns on the
// stand-in Claude Code (test/fakes/claude.mjs), which starts the relay as a child.
// A value of undefined takes the variable out while the test runs.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project on this computer with the bot's own chat as session 1.
function world(t) {
  const dir = temp(t); environment(t, { XDG_CONFIG_HOME: path.join(dir, 'personal') });
  const root = path.join(dir, 'web'); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo);
  saveTask(repo, { id: '1', kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: 'Oversee the sessions', state: 'answered', createdAt: new Date().toISOString(), runs: [], messages: [], reviews: [], responses: [], sessions: {}, permissions: 'auto', botChat: 'orchestrator' });
  return { dir, root, repo, log: path.join(dir, 'approvals.jsonl') };
}
function start(t, argv) {
  const input = new PassThrough(), output = new PassThrough(), rows = [], waiting = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) { rows.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); waiting.splice(0).forEach(resolve => resolve()); }
  });
  const done = serve({ argv, input, output });
  t.after(() => { input.end(); return done; });
  let id = 0;
  const next = async predicate => { for (;;) { const row = rows.find(predicate); if (row) return row; await new Promise(resolve => waiting.push(resolve)); } };
  const call = (name, args, meta) => { const at = ++id; input.write(`${JSON.stringify({ jsonrpc: '2.0', id: at, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })}\n`); return { at, reply: () => next(row => row.id === at) }; };
  const ask = (tool, toolInput = {}) => call(TOOL_NAME, { tool_name: tool, input: toolInput });
  const list = async () => { const at = ++id; input.write(`${JSON.stringify({ jsonrpc: '2.0', id: at, method: 'tools/list' })}\n`); return (await next(row => row.id === at)).result.tools.map(tool => tool.name); };
  return { rows, call, ask, list, next };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > ms) throw new Error('Timed out.'); await sleep(20); } };
const answer = row => JSON.parse(row.result.content[0].text);
const argv = (w, { mode = 'full', bot = 'orchestrator', servers = ['elu', 'gmail', 'slack'] } = {}) => ['--session', 'sess-1', '--root', w.root, '--task', '1', '--role', `bot:${bot}`, '--vendor', 'claude', '--log', w.log, '--wait', '600', '--rules', 'saved', '--sandboxed', 'no', '--mode', mode, '--folders', '[]', '--oversee', bot, '--servers', JSON.stringify(servers)];

// Real tool names of common MCP servers, and whether each only reads. Allowed without asking
// only when it reads: a name with no reading word, or with any word that changes, asks.
const NAMES = [
  ['gmail', 'search_emails', true], ['gmail', 'read_email', true], ['gmail', 'list_email_labels', true], ['gmail', 'list_filters', true], ['gmail', 'get_filter', true],
  ['gmail', 'send_email', false], ['gmail', 'draft_email', false], ['gmail', 'modify_email', false], ['gmail', 'delete_email', false], ['gmail', 'batch_modify_emails', false],
  ['gmail', 'batch_delete_emails', false], ['gmail', 'create_label', false], ['gmail', 'update_label', false], ['gmail', 'delete_label', false], ['gmail', 'get_or_create_label', false],
  ['gmail', 'download_attachment', false], ['gmail', 'create_filter', false], ['gmail', 'delete_filter', false],
  ['Gmail', 'search_threads', true], ['Gmail', 'get_thread', true], ['Gmail', 'get_message', true], ['Gmail', 'list_labels', true], ['Gmail', 'list_drafts', true],
  ['Gmail', 'create_draft', false], ['Gmail', 'send_message', false], ['Gmail', 'reply', false], ['Gmail', 'forward', false], ['Gmail', 'label_message', false], ['Gmail', 'trash_thread', false], ['Gmail', 'untrash_message', false],
  ['slack', 'slack_list_channels', true], ['slack', 'slack_get_channel_history', true], ['slack', 'slack_get_thread_replies', true], ['slack', 'slack_get_users', true], ['slack', 'slack_get_user_profile', true],
  ['slack', 'slack_post_message', false], ['slack', 'slack_reply_to_thread', false], ['slack', 'slack_add_reaction', false], ['slack', 'conversations_history', false], ['slack', 'chat_postMessage', false],
  ['github', 'search_repositories', true], ['github', 'search_code', true], ['github', 'search_issues', true], ['github', 'get_file_contents', true], ['github', 'list_commits', true], ['github', 'get_pull_request', true],
  ['github', 'create_issue', false], ['github', 'update_issue', false], ['github', 'add_issue_comment', false], ['github', 'create_pull_request', false], ['github', 'merge_pull_request', false], ['github', 'create_or_update_file', false], ['github', 'push_files', false], ['github', 'fork_repository', false], ['github', 'create_branch', false],
  ['postgres', 'query', false], ['postgres', 'execute_sql', false], ['postgres', 'list_tables', true], ['postgres', 'describe_table', true],
  ['linear', 'list_issues', true], ['linear', 'get_issue', true], ['linear', 'list_projects', true], ['linear', 'create_issue', false], ['linear', 'update_issue', false],
  ['notion', 'notion-search', true], ['notion', 'notion-fetch', true], ['notion', 'notion-create-pages', false], ['notion', 'notion-update-page', false],
  ['filesystem', 'read_file', true], ['filesystem', 'list_directory', true], ['filesystem', 'search_files', true], ['filesystem', 'get_file_info', true], ['filesystem', 'write_file', false], ['filesystem', 'edit_file', false], ['filesystem', 'move_file', false], ['filesystem', 'create_directory', false],
  ['google-drive', 'google_drive_search', true], ['google-drive', 'google_drive_fetch', true],
  ['playwright', 'browser_navigate', false], ['playwright', 'browser_click', false],
  ['elu', 'ask_elu', true], ['elu', 'list_issues', true], ['elu', 'create_issue', false],
];

// Tool names as the servers people connect publish them, by server: what only reads, and what
// changes, sends, spends or runs something. asks: tools that only read but ask all the same,
// which is safe, kept few: a name that does not start with a reading word (pods_list) or that
// names a change too (get_tag). Others like them (get_merge_request) are left out of the lists.
const SOURCES = {
  github: {
    reads: ['get_me', 'get_issue', 'get_issue_comments', 'list_issues', 'search_issues', 'get_pull_request', 'list_pull_requests', 'get_pull_request_files', 'get_pull_request_status', 'get_pull_request_comments', 'get_pull_request_reviews', 'get_pull_request_diff', 'list_branches', 'search_repositories', 'get_file_contents', 'list_commits', 'search_code', 'list_tags', 'search_users', 'list_notifications', 'get_notification_details', 'list_code_scanning_alerts', 'get_code_scanning_alert', 'list_secret_scanning_alerts', 'list_workflows', 'list_workflow_runs', 'list_workflow_jobs', 'get_job_logs', 'list_discussions', 'get_discussion', 'list_releases', 'get_latest_release', 'list_starred_repositories', 'list_sub_issues', 'get_team_members'],
    asks: ['get_tag'],
    changes: ['create_issue', 'add_issue_comment', 'update_issue', 'assign_copilot_to_issue', 'merge_pull_request', 'update_pull_request_branch', 'create_pending_pull_request_review', 'add_pull_request_review_comment_to_pending_review', 'submit_pending_pull_request_review', 'delete_pending_pull_request_review', 'create_and_submit_pull_request_review', 'create_pull_request', 'update_pull_request', 'request_copilot_review', 'create_or_update_file', 'delete_file', 'push_files', 'create_repository', 'fork_repository', 'create_branch', 'dismiss_notification', 'mark_all_notifications_read', 'manage_notification_subscription', 'run_workflow', 'rerun_workflow_run', 'rerun_failed_jobs', 'cancel_workflow_run', 'download_workflow_run_artifact', 'delete_workflow_run_logs', 'create_gist', 'update_gist', 'star_repository', 'unstar_repository', 'add_sub_issue', 'remove_sub_issue', 'reprioritize_sub_issue'],
  },
  gitlab: {
    reads: ['list_issue_links', 'list_issue_discussions', 'list_namespaces', 'get_namespace', 'get_project', 'list_projects', 'list_labels', 'get_repository_tree', 'list_pipelines', 'get_pipeline', 'list_pipeline_jobs', 'get_pipeline_job_output', 'list_milestones', 'get_milestone', 'get_users', 'list_events', 'get_project_events'],
    changes: ['create_merge_request', 'update_merge_request', 'create_note', 'create_merge_request_thread', 'update_merge_request_note', 'create_issue_note', 'delete_issue', 'create_issue_link', 'delete_issue_link', 'create_label', 'delete_label', 'create_wiki_page', 'update_wiki_page', 'delete_wiki_page', 'create_pipeline', 'retry_pipeline', 'cancel_pipeline', 'create_milestone', 'edit_milestone', 'delete_milestone', 'promote_milestone', 'upload_markdown', 'play_pipeline_job', 'retry_pipeline_job', 'cancel_pipeline_job', 'approve_merge_request', 'unapprove_merge_request'],
  },
  slack: {
    reads: ['slack_list_channels', 'slack_get_channel_history', 'slack_get_thread_replies', 'slack_get_users', 'slack_get_user_profile', 'slack_search_public', 'slack_search_public_and_private', 'slack_search_channels', 'slack_search_users', 'slack_read_channel', 'slack_read_thread', 'slack_read_canvas', 'slack_read_user_profile'],
    asks: ['channels_list', 'users_search', 'usergroups_list'],
    changes: ['slack_post_message', 'slack_reply_to_thread', 'slack_add_reaction', 'slack_send_message', 'slack_schedule_message', 'slack_send_message_draft', 'slack_create_canvas', 'conversations_add_message', 'reactions_add', 'reactions_remove', 'usergroups_create', 'usergroups_update', 'usergroups_users_update'],
  },
  gmail: {
    reads: ['search_emails', 'read_email', 'list_email_labels', 'list_filters', 'get_filter', 'search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts'],
    changes: ['send_email', 'draft_email', 'modify_email', 'delete_email', 'batch_modify_emails', 'batch_delete_emails', 'create_label', 'update_label', 'delete_label', 'get_or_create_label', 'create_filter', 'create_filter_from_template', 'delete_filter', 'download_attachment', 'create_draft', 'update_draft', 'delete_draft', 'send_message', 'reply', 'forward', 'trash_message', 'untrash_thread', 'label_message', 'unlabel_thread', 'mark_message_spam', 'apply_sensitive_message_label', 'update_message_labels', 'download_gmail_attachment'],
  },
  google_workspace: {
    reads: ['search_drive_files', 'get_drive_file_content', 'get_drive_file_permissions', 'list_drive_items', 'list_calendars', 'get_events', 'search_gmail_messages', 'get_gmail_message_content', 'get_gmail_thread_content', 'list_gmail_labels', 'search_docs', 'get_doc_content', 'list_docs_in_folder', 'list_spreadsheets', 'get_spreadsheet_info', 'read_sheet_values', 'read_document_comments', 'get_presentation', 'get_form', 'list_form_responses', 'list_task_lists', 'list_tasks', 'get_task', 'list_spaces', 'get_messages', 'search_messages'],
    changes: ['create_drive_file', 'update_drive_file', 'create_event', 'modify_event', 'delete_event', 'send_gmail_message', 'draft_gmail_message', 'manage_gmail_label', 'modify_gmail_message_labels', 'create_doc', 'modify_doc_text', 'find_and_replace_doc', 'insert_doc_elements', 'insert_doc_image', 'update_doc_headers_footers', 'batch_update_doc', 'create_table_with_data', 'export_doc_to_pdf', 'modify_sheet_values', 'create_spreadsheet', 'create_sheet', 'create_document_comment', 'reply_to_document_comment', 'resolve_document_comment', 'create_presentation', 'batch_update_presentation', 'create_form', 'set_publish_settings', 'create_task_list', 'update_task_list', 'delete_task_list', 'create_task', 'update_task', 'delete_task', 'move_task', 'clear_completed_tasks', 'send_message'],
  },
  'google-drive': { reads: ['google_drive_search', 'google_drive_fetch'], changes: [] },
  'google-calendar': { reads: ['list-calendars', 'list-events', 'search-events', 'get-event', 'list-colors', 'get-freebusy', 'get-current-time'], changes: ['create-event', 'update-event', 'delete-event', 'respond-to-event', 'manage-accounts'] },
  'word-document-server': {
    reads: ['get_document_info', 'get_document_text', 'get_document_outline', 'list_available_documents', 'get_document_xml', 'get_paragraph_text_from_document', 'find_text_in_document', 'get_all_comments', 'get_comments_by_author'],
    changes: ['create_document', 'copy_document', 'insert_header_near_text', 'insert_line_or_paragraph_near_text', 'add_paragraph', 'add_heading', 'add_picture', 'add_table', 'add_page_break', 'delete_paragraph', 'search_and_replace', 'format_text', 'create_custom_style', 'format_table', 'set_table_cell_shading', 'merge_table_cells', 'protect_document', 'unprotect_document', 'add_footnote_to_document', 'convert_to_pdf', 'replace_paragraph_block_below_header', 'replace_block_between_manual_anchors', 'add_digital_signature'],
  },
  excel: {
    reads: ['read_data_from_excel', 'get_workbook_metadata', 'get_merged_cells', 'get_data_validation_info'],
    changes: ['apply_formula', 'format_range', 'write_data_to_excel', 'create_workbook', 'create_worksheet', 'create_chart', 'create_pivot_table', 'create_table', 'copy_worksheet', 'delete_worksheet', 'rename_worksheet', 'merge_cells', 'unmerge_cells', 'copy_range', 'delete_range', 'insert_rows', 'insert_columns', 'delete_sheet_rows'],
  },
  ms365: {
    reads: ['list-mail-messages', 'get-mail-message', 'list-calendar-events', 'list-drives', 'list-folder-files', 'list-excel-worksheets', 'get-excel-range', 'list-todo-tasks'],
    changes: ['send-mail', 'delete-mail-message', 'create-draft-email', 'create-calendar-event', 'update-calendar-event', 'delete-calendar-event', 'upload-file-content', 'create-excel-chart', 'format-excel-range', 'sort-excel-range', 'create-onenote-page', 'create-todo-task', 'download-onedrive-file-content'],
  },
  linear: {
    reads: ['list_comments', 'list_cycles', 'get_document', 'list_documents', 'get_issue', 'get_issue_git_branch_name', 'list_issues', 'list_issue_statuses', 'get_issue_status', 'list_my_issues', 'list_issue_labels', 'list_projects', 'get_project', 'list_project_labels', 'list_teams', 'get_team', 'list_users', 'get_user', 'search_documentation'],
    changes: ['create_comment', 'create_issue', 'update_issue', 'create_project', 'update_project'],
  },
  atlassian: {
    reads: ['getConfluenceSpaces', 'getConfluencePage', 'getPagesInConfluenceSpace', 'getConfluencePageFooterComments', 'getConfluencePageInlineComments', 'getConfluencePageDescendants', 'searchConfluenceUsingCql', 'getJiraIssue', 'getTransitionsForJiraIssue', 'lookupJiraAccountId', 'searchJiraIssuesUsingJql', 'getJiraIssueRemoteIssueLinks', 'getVisibleJiraProjects', 'getJiraProjectIssueTypesMetadata', 'search', 'fetch'],
    changes: ['createConfluencePage', 'updateConfluencePage', 'createConfluenceFooterComment', 'createConfluenceInlineComment', 'editJiraIssue', 'createJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue'],
  },
  'mcp-atlassian': { reads: [], changes: ['jira_create_issue', 'jira_update_issue', 'jira_delete_issue', 'jira_transition_issue', 'jira_add_comment', 'jira_add_worklog', 'jira_link_to_epic', 'jira_batch_create_issues', 'confluence_create_page', 'confluence_update_page', 'confluence_delete_page', 'confluence_add_label'] },
  notion: {
    reads: ['notion-search', 'notion-fetch', 'notion-get-comments', 'notion-get-users', 'notion-get-user', 'notion-get-self', 'notion-get-teams'],
    changes: ['notion-create-pages', 'notion-update-page', 'notion-move-pages', 'notion-duplicate-page', 'notion-create-database', 'notion-update-database', 'notion-create-comment'],
  },
  notionApi: { reads: [], changes: ['API-post-database-query', 'API-patch-block-children', 'API-update-a-block', 'API-delete-a-block', 'API-patch-page', 'API-create-a-page', 'API-create-a-comment', 'API-create-a-database', 'API-update-a-database'] },
  sentry: {
    reads: ['find_organizations', 'find_teams', 'find_projects', 'find_issues', 'find_releases', 'find_tags', 'get_issue_details', 'get_trace_details', 'get_event_attachment', 'search_events', 'search_docs', 'get_doc', 'search_issues', 'find_dsns'],
    changes: ['update_issue', 'create_team', 'create_project', 'update_project', 'create_dsn', 'analyze_issue_with_seer'],
  },
  postgres: { reads: [], changes: ['query'] },
  supabase: {
    reads: ['list_tables', 'list_extensions', 'list_migrations', 'get_logs', 'get_advisors', 'get_project_url', 'search_docs', 'list_edge_functions', 'list_branches', 'list_projects', 'get_project', 'get_cost', 'list_organizations', 'get_organization'],
    changes: ['apply_migration', 'execute_sql', 'generate_typescript_types', 'deploy_edge_function', 'create_branch', 'delete_branch', 'merge_branch', 'reset_branch', 'rebase_branch', 'confirm_cost', 'create_project', 'pause_project', 'restore_project'],
  },
  sqlite: { reads: ['list_tables', 'describe_table'], changes: ['read_query', 'write_query', 'create_table', 'append_insight'] },
  mysql: { reads: [], changes: ['execute_sql'] },
  mongodb: { reads: ['find', 'count', 'list-collections', 'list-databases'], changes: ['insert-many', 'update-many', 'delete-many', 'create-index', 'drop-collection', 'rename-collection', 'aggregate'] },
  dynamodb: { reads: ['get_item', 'list_tables', 'describe_table'], changes: ['put_item', 'update_item', 'delete_item', 'query', 'scan', 'create_table', 'delete_table'] },
  bigquery: { reads: ['list-tables', 'describe-table'], changes: ['execute-query', 'run_query'] },
  stripe: {
    reads: ['list_customers', 'list_products', 'list_prices', 'list_invoices', 'list_payment_intents', 'list_subscriptions', 'list_coupons', 'list_disputes', 'search_documentation', 'search_stripe_resources', 'fetch_stripe_resources', 'get_stripe_account_info'],
    changes: ['create_customer', 'create_product', 'create_price', 'create_payment_link', 'create_invoice', 'create_invoice_item', 'finalize_invoice', 'create_refund', 'cancel_subscription', 'update_subscription', 'create_coupon', 'update_dispute'],
  },
  'robinhood-trading': {
    reads: ['get_equity_orders', 'get_portfolio', 'get_accounts', 'get_equity_quotes', 'get_watchlists'],
    changes: ['place_equity_order', 'cancel_equity_order', 'exercise_option', 'place_crypto_order', 'review_equity_order', 'run_scan', 'create_alert', 'mark_alerts_read', 'add_to_watchlist', 'remove_from_watchlist', 'follow_watchlist', 'decline_trade_approval', 'set_legend_chart_settings', 'update_scan_filters'],
  },
  playwright: {
    reads: [], asks: ['browser_tab_list'],
    changes: ['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_hover', 'browser_drag', 'browser_select_option', 'browser_press_key', 'browser_file_upload', 'browser_handle_dialog', 'browser_evaluate', 'browser_close', 'browser_resize', 'browser_tab_new', 'browser_tab_select', 'browser_tab_close', 'browser_install', 'browser_fill_form', 'browser_pdf_save', 'browser_take_screenshot'],
  },
  'chrome-devtools': {
    reads: ['list_pages', 'list_console_messages', 'list_network_requests', 'get_network_request'],
    changes: ['select_page', 'new_page', 'close_page', 'navigate_page', 'evaluate_script', 'click', 'fill', 'fill_form', 'hover', 'drag', 'upload_file', 'handle_dialog', 'emulate_cpu', 'resize_page', 'performance_start_trace', 'take_screenshot'],
  },
  puppeteer: { reads: [], changes: ['puppeteer_navigate', 'puppeteer_click', 'puppeteer_fill', 'puppeteer_select', 'puppeteer_evaluate', 'puppeteer_hover', 'puppeteer_screenshot'] },
  fetch: { reads: ['fetch'], changes: [] },
  firecrawl: { reads: ['firecrawl_search'], changes: ['firecrawl_scrape', 'firecrawl_crawl', 'firecrawl_extract', 'firecrawl_deep_research'] },
  'brave-search': { reads: [], changes: [], asks: ['brave_web_search', 'brave_local_search'] },
  filesystem: {
    reads: ['read_file', 'read_text_file', 'read_media_file', 'read_multiple_files', 'list_directory', 'list_directory_with_sizes', 'search_files', 'get_file_info', 'list_allowed_directories'],
    changes: ['write_file', 'edit_file', 'create_directory', 'move_file'],
  },
  'desktop-commander': {
    reads: ['read_file', 'list_directory', 'search_files', 'search_code', 'get_file_info', 'list_sessions', 'list_processes', 'get_config', 'list_searches', 'get_more_search_results', 'read_process_output'],
    changes: ['write_file', 'edit_block', 'start_process', 'interact_with_process', 'force_terminate', 'kill_process', 'set_config_value', 'start_search', 'stop_search', 'move_file'],
  },
  memory: { reads: ['read_graph', 'search_nodes'], changes: ['create_entities', 'create_relations', 'add_observations', 'delete_entities', 'delete_observations', 'delete_relations'] },
  kubernetes: {
    reads: ['list_api_resources'],
    asks: ['kubectl_get', 'kubectl_describe', 'pods_list', 'pods_get', 'events_list', 'namespaces_list', 'resources_list', 'resources_get', 'configuration_view', 'helm_list'],
    changes: ['kubectl_apply', 'kubectl_delete', 'kubectl_create', 'kubectl_scale', 'kubectl_patch', 'kubectl_rollout', 'kubectl_generic', 'kubectl_context', 'install_helm_chart', 'upgrade_helm_chart', 'uninstall_helm_chart', 'port_forward', 'stop_port_forward', 'exec_in_pod', 'cleanup', 'pods_delete', 'pods_exec', 'pods_run', 'resources_create_or_update', 'resources_delete', 'helm_install', 'helm_uninstall'],
  },
  'aws-api': { reads: [], changes: ['call_aws', 'suggest_aws_commands'] },
  'aws-docs': { reads: ['read_documentation', 'search_documentation'], changes: [] },
  cloudwatch: { reads: ['describe_log_groups', 'get_metric_data', 'get_metric_metadata', 'get_active_alarms', 'get_alarm_history'], changes: ['execute_log_insights_query', 'cancel_logs_insight_query'] },
  'cost-explorer': { reads: ['get_cost_and_usage', 'get_cost_forecast'], changes: [] },
  s3: { reads: ['list_buckets', 'get_object'], changes: ['put_object', 'delete_object', 'copy_object'] },
  apollo: {
    reads: [], asks: ['apollo_contacts_search', 'apollo_tasks_show', 'apollo_tasks_search', 'apollo_deals_search', 'apollo_deals_show'],
    changes: ['apollo_contacts_create', 'apollo_emailer_messages_send_now', 'apollo_emailer_campaigns_approve', 'apollo_people_bulk_match', 'apollo_organizations_enrich', 'apollo_email_account_purchase_create', 'apollo_duplicate_contacts_merge', 'apollo_tasks_complete', 'apollo_sequences_create'],
  },
  hubspot: { reads: ['hubspot-search-objects', 'hubspot-list-objects', 'hubspot-get-user-details'], changes: ['hubspot-batch-create-objects', 'hubspot-batch-update-objects', 'hubspot-create-engagement', 'hubspot-generate-feedback-link'] },
  asana: { reads: ['asana_list_workspaces', 'asana_search_projects', 'asana_get_task', 'asana_search_tasks'], changes: ['asana_create_task', 'asana_update_task', 'asana_add_task_dependencies', 'asana_create_task_story'] },
  twilio: { reads: [], changes: ['send_sms', 'make_call'] },
};

test('every tool of a connected server that changes, sends, spends or runs something asks, in every mode', () => {
  const all = kind => Object.entries(SOURCES).flatMap(([server, tools]) => (tools[kind] ?? []).map(tool => [server, tool]));
  assert.ok(all('reads').length + all('changes').length >= 150, `${all('reads').length + all('changes').length} names`);
  assert.ok(all('changes').length >= 150, 'at least 150 that change something');
  for (const [server, tool] of [...all('changes'), ...all('asks')]) {
    assert.equal(readingTool(server, tool), false, `${server} ${tool} asks`);
    for (const mode of ['ask', 'auto', 'full']) assert.equal(overseeingAnswer(`mcp__${server}__${tool}`, { mode, servers: [server] }), 'ask', `${server} ${tool} in ${mode}`);
  }
  assert.ok(all('asks').length * 10 < all('reads').length, `${all('asks').length} reading tools ask, of ${all('asks').length + all('reads').length}`);
  for (const [server, tool] of all('reads')) {
    assert.equal(readingTool(server, tool), true, `${server} ${tool} only reads`);
    assert.equal(overseeingAnswer(`mcp__${server}__${tool}`, { mode: 'full', servers: [server] }), 'allow', `${server} ${tool}`);
  }
});

test('a reading tool is told by the words of its name, after the server\'s own name is dropped', () => {
  assert.ok(NAMES.length >= 40);
  for (const [server, tool, reads] of NAMES) assert.equal(readingTool(server, tool), reads, `${server} ${tool}`);
  // The words that change are looked for only after the server's own name: send_list lists on a
  // server named send, and sends on any other.
  assert.equal(readingTool('send', 'send_list'), true);
  assert.equal(readingTool('mail', 'send_list'), false);
  assert.equal(readingTool('post', 'post_search'), true);
  assert.equal(readingTool('slack', 'post_search'), false);
  // A name in camel case reads the same.
  assert.deepEqual(['searchEmails', 'getUserProfile', 'sendEmail', 'createDraft'].map(tool => readingTool('mail', tool)), [true, true, false, false]);
  // The table: reads allowed, the rest asks, and an edit or command is refused in every mode.
  const servers = ['gmail', 'elu'];
  for (const mode of ['ask', 'auto', 'full']) {
    assert.equal(overseeingAnswer('mcp__gmail__search_emails', { mode, servers }), 'allow', mode);
    assert.equal(overseeingAnswer('mcp__gmail__send_email', { mode, servers }), 'ask', mode);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.equal(overseeingAnswer(tool, { mode, servers }), 'deny', `${mode} ${tool}`);
  }
});

// A reading word at the end of a name is often a noun, a change hides in a word glued together,
// and a plural or a noun in -ment is a thing, not a change.
test('a name reads only when its first word reads and nothing in it can change something, glued words included', () => {
  const changes = ['append_to_list', 'alter_view', 'increment_count', 'pop_from_list', 'hide_view', 'tag_search', 'settings_get', 'items.count', 'get_and_increment', 'search_and_append', 'get_and_append_rows', 'find_and_alter',
    'list.bulkdelete', 'get_bulkdelete', 'get_and_bulkdelete', 'list-bulkDelete', 'find_and_tag', 'fetch_and_hide', 'list_and_flag', 'get_and_dequeue', 'get_and_consume', 'get_and_claim', 'get_and_expire', 'fetch_and_ingest',
    'list_pop', 'find_incr', 'count_and_decrement', 'search_reindex', 'get_ping', 'search_and_spam', 'get_and_evict', 'get_and_lease', 'list_and_sendemail', 'search_email2send', 'read_markread', 'get_createorupdate', 'list_updated_and_deleted'];
  for (const tool of changes) assert.equal(readingTool('things', tool), false, tool);
  // After a joining word only a part that reads again reads, so a change this file has no word for asks too.
  for (const tool of ['get_and_unarchive', 'get_and_unset', 'get_or_unset', 'fetch_and_sign', 'get_and_void', 'fetch_and_dispatch', 'get_and_release', 'find_and_email', 'search_and_message', 'get_and_undo', 'get_and_bulkedit', 'get_and_deletes', 'get_then_zap', 'list_plus_frobnicate', 'get_and', 'list_unarchive', 'get_bulkedit', 'find_massupdate']) assert.equal(readingTool('things', tool), false, tool);
  for (const tool of ['get_and_list_items', 'search_or_find_users', 'search_public_and_private', 'list_issues_and_pull_requests', 'get_cost_and_usage', 'list_unread', 'get_units', 'read_email', 'get_message', 'search_messages']) assert.equal(readingTool('things', tool), true, tool);
  // A reading tool told to send: a method that is not a reading one, at any depth, asks.
  const fetch = input => overseeingAnswer('mcp__http__fetch', { mode: 'full', servers: ['http'], input });
  assert.equal(fetch({ url: 'https://a.example/page' }), 'allow'); assert.equal(fetch({ url: 'https://a.example/page', method: 'get' }), 'allow');
  for (const input of [{ url: 'https://a.example/page', method: 'POST' }, { url: 'https://a.example/page', options: { http_method: 'delete' } }, { request: [{ verb: 'PUT' }] }, { method: 7 }, { httpMethod: 'PATCH' }]) assert.equal(fetch(input), 'ask', JSON.stringify(input));
  for (const tool of ['list_updates', 'list_commits', 'list_comments', 'get_orders', 'get_deployment', 'list_deployments', 'get_replacements', 'search', 'getUserProfile', 'list_ec2_instances']) assert.equal(readingTool('things', tool), true, tool);
  for (const [server, tool] of [['todo', 'append_to_list'], ['db', 'alter_view'], ['counter', 'increment_count'], ['redis', 'pop_from_list'], ['notes', 'hide_view'], ['mail', 'tag_search'], ['google_workspace', 'find_and_replace_doc']]) {
    for (const mode of ['ask', 'auto', 'full']) assert.equal(overseeingAnswer(`mcp__${server}__${tool}`, { mode, servers: [server], input: {} }), 'ask', `${tool} in ${mode}`);
  }
});

test('the relay of the overseeing turn serves its ten tools, and none for the other computers', async t => {
  const w = world(t), server = start(t, argv(w));
  assert.deepEqual(await server.list(), [TOOL_NAME, ...ORCH_TOOLS]);
  // One of the ten runs through act for the session the turn is in.
  const read = await server.call('sessions_list', {}).reply();
  assert.equal(read.result.isError, undefined, read.result.content[0].text);
  // A tool it does not have is unknown, as before.
  assert.equal((await server.call('list_other_sessions', {}).reply()).error.code, -32602);
  // Another role's relay, or one in a session of no project here, serves none of them.
  const plain = start(t, argv(w).slice(0, -4));
  assert.deepEqual(await plain.list(), [TOOL_NAME, 'list_other_sessions', 'send_to_session']);
  assert.equal((await plain.call('sessions_list', {}).reply()).error.code, -32602);
  const elsewhere = start(t, argv(w).map(value => value === w.root ? path.join(w.dir, 'none') : value));
  assert.deepEqual(await elsewhere.list(), [TOOL_NAME]);
  // --oversee names the bot whose turn it is, and only it.
  await assert.rejects(serve({ argv: argv(w).map(value => value === 'bot:orchestrator' ? 'lead' : value), input: new PassThrough(), output: new PassThrough() }), /--oversee names the bot whose turn this is/);
  await assert.rejects(serve({ argv: argv(w).map(value => value === '["elu","gmail","slack"]' ? '"elu"' : value), input: new PassThrough(), output: new PassThrough() }), /--servers is a list of server names/);
  // The launch passes both, with the servers the turn has.
  const spec = approvalServer({ session: 's1', root: w.root, taskId: '1', role: 'bot:orchestrator', log: w.log, mode: 'auto', oversee: 'orchestrator', servers: ['elu', 'gmail'] });
  assert.deepEqual(spec.args.slice(-4), ['--oversee', 'orchestrator', '--servers', '["elu","gmail"]']);
  assert.equal(approvalServer({ session: 's1', log: w.log }).args.includes('--oversee'), false);
  assert.throws(() => approvalServer({ session: 's1', log: w.log, oversee: 'Bad Name' }), /names the bot that oversees/);
  assert.equal(SERVER_NAME, 'elu-code-approval');
});

test('in Full access an edit or a command is refused, a read is allowed, and a change asks the owner with no rule or Full answering it', async t => {
  const w = world(t), server = start(t, argv(w));
  for (const [tool, input] of [['Edit', { file_path: path.join(w.root, 'a.txt') }], ['Write', { file_path: path.join(w.root, 'b.txt') }], ['Bash', { command: 'ls' }]]) {
    const out = answer(await server.ask(tool, input).reply());
    assert.deepEqual(out, { behavior: 'deny', message: OVERSEE_DENIED }, tool);
  }
  assert.equal(answer(await server.ask('mcp__gmail__search_emails', { query: 'invoice' }).reply()).behavior, 'allow');
  assert.deepEqual(pendingApprovals(), [], 'nothing was asked');
  // A source's change, and the web in a session that asks first, reach the owner as they are.
  saveRule({ kind: 'fetch', domain: 'example.test' }, { scope: 'all' });
  const send = server.ask('mcp__gmail__send_email', { to: 'a@example.test', subject: 'Hi' });
  await until(() => pendingApprovals().length === 1);
  const [asked] = pendingApprovals();
  assert.equal(asked.role, 'bot:orchestrator'); assert.equal(asked.rules, undefined, 'no rule is offered for it');
  assert.equal(server.rows.some(row => row.id === send.at), false, 'Full access does not answer it');
  answerApproval(asked.id, 'deny');
  assert.match(answer(await send.reply()).message, /The owner declined this/);
  const web = start(t, argv(w, { mode: 'ask' })), fetch = web.ask('WebFetch', { url: 'https://example.test/page' });
  await until(() => pendingApprovals().length === 1);
  answerApproval(pendingApprovals()[0].id, 'allow');
  assert.equal(answer(await fetch.reply()).behavior, 'allow');
  // The session says what its table allowed as allowed by default, never as the owner's yes.
  const log = readApprovalLog(w.log), raw = fs.readFileSync(w.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(row => [row.tool, row.decision, row.by ?? null]), [['Edit', 'deny', null], ['Write', 'deny', null], ['Bash', 'deny', null], ['mcp__gmail__search_emails', 'allow', 'default'], ['mcp__gmail__send_email', 'deny', null], ['WebFetch', 'allow', null]]);
  assert.equal(log[3].rule, 'what the bot that oversees your sessions uses without asking');
  assert.deepEqual(raw.map(row => row.by ?? null), ['oversee', 'oversee', 'oversee', 'default', null, null]);
});

test('each question to ELU that goes is a line of the action log, and past the cap a day one is refused in one sentence', async t => {
  const w = world(t), file = actionsFile(), now = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 19 questions in the last day, one of them logged ten minutes ahead of a clock set back since,
  // one older than a day, and an ELU tool that is not a question.
  const row = (n, ago, extra = {}) => JSON.stringify({ id: `a${n}`, at: new Date(now - ago).toISOString(), bot: 'orchestrator', from: { root: w.root, session: '1', run: 'r' }, action: 'ask_elu', target: null, summary: 'Ask ELU', level: null, decision: 'allow', by: 'level', undo: null, undoneAt: null, ...extra });
  fs.writeFileSync(file, [...Array.from({ length: 19 }, (_, at) => row(at + 1, at ? 3600000 : -600000)), row(20, 25 * 3600000), row(21, 60000, { action: 'card_add' })].join('\n') + '\n');
  const server = start(t, argv(w));
  assert.equal(answer(await server.ask('mcp__elu__ask_elu', { question: 'Which pages lose the most users?' }).reply()).behavior, 'allow');
  const logged = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([logged.id, logged.action, logged.decision, logged.bot, logged.summary, logged.from.session], ['a22', 'ask_elu', 'allow', 'orchestrator', 'Ask ELU: "Which pages lose the most users?"', '1']);
  // That was the 20th: the next is refused, and says so.
  assert.equal(ELU_CALLS_PER_DAY, 20);
  const refused = answer(await server.ask('mcp__elu__ask_elu', { question: 'And on mobile?' }).reply());
  assert.equal(refused.behavior, 'deny');
  assert.equal(refused.message, 'The owner\'s cap is 20 questions to ELU a day and you asked 20 in the last 24 hours, so this one was not sent: say in your reply what you would ask.');
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1).decision, 'capped');
  // ELU's other reading tool is not a question, and is not counted.
  assert.equal(answer(await server.ask('mcp__elu__list_issues', {}).reply()).behavior, 'allow');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 23);
});

test('the same answers come for a question Claude Code asks on its own output', async t => {
  const w = world(t), ctx = { mode: 'full', root: w.root, taskId: '1', role: 'bot:orchestrator', vendor: 'claude', bot: 'orchestrator', servers: ['elu', 'gmail'], run: 'sess-1', rules: 'saved' };
  assert.deepEqual(await overseeing('Bash', { command: 'rm -rf build' }, { id: 'c1', ...ctx }), { decision: 'deny', by: 'oversee', summary: 'Run: rm -rf build', message: OVERSEE_DENIED });
  assert.equal((await overseeing('mcp__gmail__read_email', { id: 'm1' }, { id: 'c2', ...ctx })).decision, 'allow');
  // What asks waits for the owner, marked as the bot's own question, and a timeout says so.
  const asked = [];
  const out = await overseeing('mcp__gmail__send_email', {}, { id: 'c3', ...ctx, waitSeconds: 1, onAsk: summary => asked.push([summary, pendingApprovals().find(row => row.id === 'c3')?.oversee]) });
  assert.equal(out.decision, 'timeout'); assert.match(out.message, /No answer from the owner within 1 minutes?/);
  assert.deepEqual(asked, [['Use mcp__gmail__send_email', true]]);
});

test('a web fetch whose address carries a query, a fragment or a sign-in asks the owner in every mode, and so does a source\'s reading tool handed one', async t => {
  for (const mode of ['ask', 'auto', 'full']) {
    for (const url of ['https://example.test/page?q=the-fact', 'https://example.test/page#the-fact', 'https://example.test/page?', 'https://me:pw@example.test/page', 'example.test/page', 'ftp://example.test/a', '', null]) assert.equal(overseeingAnswer('WebFetch', { mode, input: { url, prompt: 'Read it' } }), 'ask', `${mode} ${url}`);
    assert.equal(overseeingAnswer('WebFetch', { mode }), 'ask', `${mode}, with no address`);
    assert.equal(overseeingAnswer('mcp__fetch__fetch', { mode, servers: ['fetch'], input: { url: 'https://example.test/?q=the-fact' } }), 'ask', mode);
    assert.equal(overseeingAnswer('mcp__firecrawl__firecrawl_search', { mode, servers: ['firecrawl'], input: { query: 'pricing', sources: ['https://example.test/#the-fact'] } }), 'ask', mode);
  }
  // A plain address reads as before: the web by the mode, a source's read at once.
  assert.deepEqual(['ask', 'auto', 'full'].map(mode => overseeingAnswer('WebFetch', { mode, input: { url: 'https://example.test/page', prompt: 'Read it' } })), ['ask', 'allow', 'allow']);
  assert.equal(overseeingAnswer('mcp__fetch__fetch', { mode: 'full', servers: ['fetch'], input: { url: 'https://example.test/page', max_length: 5000 } }), 'allow');
  // Through the relay of a turn in Full access, it waits for the owner and his no holds.
  const w = world(t), server = start(t, argv(w));
  const fetch = server.ask('WebFetch', { url: 'https://example.test/a?fact=the-quote', prompt: 'Read it' });
  await until(() => pendingApprovals().length === 1);
  // Answered and replied to before it is looked at, so a wrong row ends the test, not the wait.
  const [asked] = pendingApprovals(); answerApproval(asked.id, 'deny');
  const denied = answer(await fetch.reply());
  assert.deepEqual([asked.tool, asked.oversee, denied.behavior], ['WebFetch', true, 'deny']);
  assert.equal(answer(await server.ask('WebFetch', { url: 'https://example.test/a', prompt: 'Read it' }).reply()).behavior, 'allow');
});

test('a source\'s reading tool asks when any string it is handed, at any depth, holds an address with a query, a fragment or a sign-in, with or without a scheme', () => {
  const read = input => overseeingAnswer('mcp__fetch__fetch', { mode: 'full', servers: ['fetch'], input });
  for (const input of [{ url: 'evil.example/?q=the-fact' }, { url: 'evil.example#the-fact' }, { url: 'me:pw@evil.example/page' }, { request: { url: 'https://evil.example/?q=the-fact' } }, { pages: [{ at: ['https://evil.example/#the-fact'] }] },
    { 'https://evil.example/?q=the-fact': true }, { url: 'url=https://evil.example/?q=s' }, { query: 'read https://evil.example/?q=s now' }, { url: 'file:///etc/hosts' }]) assert.equal(read(input), 'ask', JSON.stringify(input));
  // An input nested deeper than anyone writes one is taken as holding one.
  let deep = { url: 'https://example.test/page' }; for (let at = 0; at < 25; at++) deep = { deep }; assert.equal(read(deep), 'ask');
  // A plain address, with or without a scheme, an email address and plain words read at once.
  for (const input of [{ url: 'https://example.test/page' }, { url: 'example.test/page' }, { request: { url: 'https://example.test/a/b' } }, { query: 'from:bob@example.test subject:invoice' }, { query: 'what changed?' }, { max_length: 5000 }, null])
    assert.equal(read(input), 'allow', JSON.stringify(input));
  // The web fetch itself keeps its rule: a plain address is allowed above Ask for approval.
  for (const url of ['https://example.test/the-quote', 'https://the-quote.example.test/']) assert.equal(overseeingAnswer('WebFetch', { mode: 'auto', input: { url } }), 'allow', url);
});

// End to end with the stand-in Claude Code (test/fakes/claude.mjs, mode relay): it starts the
// relay from --mcp-config as the runner wrote it (lib/mcp.mjs writeServers), and asks it about
// elu sessions piped into a filter, which Claude Code's own allow list does not cover.
test('through the relay Claude Code starts, the owner\'s own turn gets elu sessions answered by a default or by his rule, and a turn the bot that oversees leads gets neither', { timeout: 120000 }, async t => {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'relay', intent: 'answer', asks: [{ tool_name: 'Bash', input: { command: 'elu sessions list | head -5' } }] });
  environment(t, { ...fake.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)), root = controller.repo.project ?? controller.repo.root;
  // Every question that waits is denied and kept, so a run never hangs on one.
  const settle = async run => {
    const asked = []; let done = false; const finished = run.finished.finally(() => { done = true; });
    while (!done) { for (const row of pendingApprovals({ root })) { asked.push(row); answerApproval(row.id, 'deny'); } await sleep(25); }
    return { task: await finished, asked };
  };
  const decided = task => (task.approvals ?? []).map(row => [row.summary, row.decision, row.by ?? null]);
  const told = () => fs.readFileSync(path.join(p.parent, 'relays.jsonl'), 'utf8').trim().split('\n').map(line => { const args = JSON.parse(line); return args.includes('--led') ? args[args.indexOf('--led') + 1] : null; });
  const line = 'Run: elu sessions list | head -5';
  // His own turn in Approve for me: allowed by default, nothing asked.
  const mine = await settle(controller.ask('Which sessions are open?', null, { permissions: 'auto' }));
  assert.equal(mine.task.state, 'answered', JSON.stringify(mine.task.error));
  assert.deepEqual([mine.asked, decided(mine.task)], [[], [[line, 'allow', 'default']]]);
  // A note of the bot's in that session: he is asked, and the question says the bot led the turn.
  const noted = await settle(controller.ask('Session 1 might also check the tests.', mine.task.id, { overseer: 'orchestrator' }));
  assert.deepEqual(noted.asked.map(row => [row.summary, row.led]), [[line, true]]);
  assert.deepEqual(decided(noted.task).at(-1), [line, 'deny', null]);
  // His saved rule answers his own turn in Ask for approval, and not one the bot leads.
  saveRule({ kind: 'command', words: ['elu', 'sessions'], exact: false, outside: true }, { scope: 'all' });
  const ruled = await settle(controller.ask('Which sessions are open now?', null, { permissions: 'ask' }));
  assert.deepEqual([ruled.asked, decided(ruled.task)], [[], [[line, 'allow', 'rule']]]);
  const again = await settle(controller.ask('Session 2 might look at the build.', ruled.task.id, { overseer: 'orchestrator' }));
  assert.deepEqual(again.asked.map(row => [row.summary, row.led]), [[line, true]]);
  assert.deepEqual(told(), ['no', 'yes', 'no', 'yes']);
});
