# Copyright 2023 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# python3
"""Cloud BigQuery module."""

import logging
from pathlib import Path
from typing import Any, Dict

import config_parser
from google.cloud import bigquery
from google.cloud import exceptions

# Main workflow sql.
_MAIN_WORKFLOW_SQL = 'sql/main_workflow.sql'
_BEST_SELLERS_WORKFLOW_SQL = 'sql/market_insights/best_sellers_workflow.sql'

# Set logging level.
logging.getLogger().setLevel(logging.INFO)
logging.getLogger('googleapiclient.discovery').setLevel(logging.WARNING)


def create_dataset_if_not_exists(project_id: str, dataset_id: str) -> None:
  """Creates BigQuery dataset if it doesn't exists.

  Args:
    project_id: A cloud project id.
    dataset_id: BigQuery dataset id.
  """
  # Construct a BigQuery client object.
  client = bigquery.Client(project=project_id)
  fully_qualified_dataset_id = f'{project_id}.{dataset_id}'
  try:
    client.get_dataset(fully_qualified_dataset_id)
    logging.info('Dataset %s already exists.', fully_qualified_dataset_id)
  except exceptions.NotFound:
    logging.info('Dataset %s is not found.', fully_qualified_dataset_id)
    dataset = bigquery.Dataset(fully_qualified_dataset_id)
    dataset.location = config_parser.get_dataset_location()
    client.create_dataset(dataset)
    logging.info('Dataset %s created.', fully_qualified_dataset_id)


def load_language_codes(project_id: str, dataset_id: str) -> None:
  """Loads language codes."""
  client = bigquery.Client(project=project_id)
  fully_qualified_table_id = f'{project_id}.{dataset_id}.language_codes'
  job_config = bigquery.LoadJobConfig(
      source_format=bigquery.SourceFormat.CSV,
      skip_leading_rows=1,
      autodetect=True,
  )
  file_name = 'data/language_codes.csv'
  with open(file_name, 'rb') as source_file:
    job = client.load_table_from_file(
        source_file, fully_qualified_table_id, job_config=job_config)

  job.result()


def load_geo_targets(project_id: str, dataset_id: str) -> None:
  """Loads geo targets."""
  client = bigquery.Client(project=project_id)
  fully_qualified_table_id = f'{project_id}.{dataset_id}.geo_targets'
  job_config = bigquery.LoadJobConfig(
      source_format=bigquery.SourceFormat.CSV,
      skip_leading_rows=1,
      autodetect=True,
  )
  file_name = 'data/geo_targets.csv'
  with open(file_name, 'rb') as source_file:
    job = client.load_table_from_file(
        source_file, fully_qualified_table_id, job_config=job_config)

  job.result()


def configure_sql(sql_path: str, query_params: Dict[str, Any]) -> str:
  """Configures parameters of SQL script with variables supplied.

  Args:
    sql_path: Path to SQL script.
    query_params: Configuration containing query parameter values.

  Returns:
    sql_script: String representation of SQL script with parameters assigned.
  """
  sql_script = Path(sql_path).read_text()
  import re

  def get_raw_ids(param_key):
    if param_key not in query_params:
      return []
    val = query_params[param_key]
    if isinstance(val, str):
      return [v.strip().replace('-', '') for v in val.split(',') if v.strip()]
    elif isinstance(val, (list, tuple)):
      return [str(v).replace('-', '') for v in val if str(v).strip()]
    else:
      return [str(val).replace('-', '')]

  raw_customer_ids = get_raw_ids('external_customer_id')
  raw_merchant_ids = get_raw_ids('merchant_id')

  match = re.search(r"CREATE OR REPLACE VIEW `\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)`", sql_script)
  ids = []
  gmc_views = ['product_view']
  ads_views = ['product_metrics_view', 'customer_view', 'adgroup_criteria_view', 'pmax_criteria_view', 'criteria_view', 'targeted_products_view', 'product_detailed_view']

  if match:
    view_name = match.group(1)
    if view_name == 'product_view':
      ids = raw_merchant_ids
    else:
      ids = raw_customer_ids if raw_customer_ids else raw_merchant_ids
  else:
    ids = raw_customer_ids if raw_customer_ids else raw_merchant_ids

  def format_params_for_account(target_merchant_id=None, target_customer_id=None):
    params = {}
    for param_key, param_value in query_params.items():
      if param_key == 'merchant_id' and target_merchant_id:
        params[param_key] = f"'{target_merchant_id}'"
      elif param_key == 'external_customer_id' and target_customer_id:
        params[param_key] = f"'{target_customer_id}'"
      elif param_key in ('merchant_id', 'external_customer_id'):
        if isinstance(param_value, str):
          id_list = [m.strip() for m in param_value.split(',')]
        elif isinstance(param_value, (list, tuple)):
          id_list = [str(m) for m in param_value]
        else:
          id_list = [str(param_value)]
        params[param_key] = ", ".join(f"'{i}'" for i in id_list)
      elif isinstance(param_value, str) and ',' in param_value:
        params[param_key] = tuple(param_value.split(','))
      else:
        params[param_key] = param_value
    return params

  if len(ids) > 0 and match:
    scripts = []
    for i, cid in enumerate(ids):
      target_merchant_id = raw_merchant_ids[i % len(raw_merchant_ids)] if raw_merchant_ids else cid
      target_customer_id = raw_customer_ids[i % len(raw_customer_ids)] if raw_customer_ids else cid
      instance_script = sql_script

      def account_replacer(m):
        table_base = m.group(1)
        alias = m.group(2)
        target_id = target_customer_id if table_base.startswith('ads_') else target_merchant_id
        if not target_id:
          return m.group(0)
        if not table_base.startswith('ads_'):
          subquery = f"SELECT *, _PARTITIONTIME, '{target_id}' as cid FROM `{{project_id}}.{{dataset}}.{table_base}_{target_id}`"
        else:
          subquery = f"SELECT *, '{target_id}' as _TABLE_SUFFIX FROM `{{project_id}}.{{dataset}}.{table_base}_{target_id}`"
        alias_name = alias or f"{table_base}_source"
        return f"({subquery}) AS {alias_name}"

      instance_script = re.sub(r"`\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)_\*`(?:\s+AS\s+([a-zA-Z0-9_]+))?", account_replacer, instance_script)
      instance_script = re.sub(r"CREATE OR REPLACE VIEW `\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)`", f"CREATE OR REPLACE VIEW `{{project_id}}.{{dataset}}.\\1_{cid}`", instance_script)

      for v in gmc_views:
        m_id = target_merchant_id or cid
        instance_script = re.sub(rf"`\{{project_id\}}\.\{{dataset\}}\.{v}`", f"`{{project_id}}.{{dataset}}.{v}_{m_id}`", instance_script)
      for v in ads_views:
        c_id = target_customer_id or target_merchant_id or cid
        instance_script = re.sub(rf"`\{{project_id\}}\.\{{dataset\}}\.{v}`", f"`{{project_id}}.{{dataset}}.{v}_{c_id}`", instance_script)

      acct_params = format_params_for_account(target_merchant_id, target_customer_id)
      scripts.append(instance_script.format(**acct_params).strip().rstrip(';'))

    base_view_name = match.group(1)
    union_queries = [f"SELECT * FROM `{{project_id}}.{{dataset}}.{base_view_name}_{cid}`" for cid in ids]
    union_sql = f"CREATE OR REPLACE VIEW `{{project_id}}.{{dataset}}.{base_view_name}` AS\n" + "\nUNION ALL\n".join(union_queries)
    union_params = format_params_for_account()
    scripts.append(union_sql.format(**union_params))
    return ";\n".join(scripts) + ";"

  def fallback_replacer(m):
    table_base = m.group(1)
    alias = m.group(2)
    target_ids = raw_customer_ids if table_base.startswith('ads_') else raw_merchant_ids
    if not target_ids:
      target_ids = raw_merchant_ids if table_base.startswith('ads_') else raw_customer_ids
    if not target_ids:
      return m.group(0)
    subqueries = []
    for cid in target_ids:
      if not table_base.startswith('ads_'):
        subqueries.append(f"SELECT *, _PARTITIONTIME, '{cid}' as cid FROM `{{project_id}}.{{dataset}}.{table_base}_{cid}`")
      else:
        subqueries.append(f"SELECT *, '{cid}' as _TABLE_SUFFIX FROM `{{project_id}}.{{dataset}}.{table_base}_{cid}`")
    alias_name = alias or f"{table_base}_source"
    return "(" + " UNION ALL ".join(subqueries) + f") AS {alias_name}"

  sql_script = re.sub(r"`\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)_\*`(?:\s+AS\s+([a-zA-Z0-9_]+))?", fallback_replacer, sql_script)
  params = format_params_for_account()
  return sql_script.format(**params)


def execute_queries(project_id: str, dataset_id: str, merchant_id: str,
                    customer_id: str, enable_market_insights: bool) -> None:
  """Executes list of queries."""
  # Sql files to be executed in a specific order.
  sql_files = [
      'sql/1_product_view.sql',
      'sql/2_product_metrics_view.sql',
      'sql/3_customer_view.sql',
      'sql/4_adgroup_criteria_view.sql',
      'sql/5_pmax_criteria_view.sql',
      'sql/6_criteria_view.sql',
      'sql/7_targeted_products_view.sql',
      'sql/8_product_detailed_view.sql',
      'sql/9_materialize_product_detailed.sql',
      'sql/10_materialize_product_historical.sql',
      _MAIN_WORKFLOW_SQL,
  ]
  if enable_market_insights:
    market_insights_sql_files = [
        'sql/market_insights/snapshot_view.sql',
        'sql/market_insights/historical_view.sql'
    ]
    sql_files.extend(market_insights_sql_files)
  query_params = {
      'project_id': project_id,
      'dataset': dataset_id,
      'merchant_id': merchant_id,
      'external_customer_id': customer_id,
      'market_insights_locale': config_parser.get_market_insights_locale()
  }
  location = config_parser.get_dataset_location()
  client = bigquery.Client(project=project_id)
  for sql_file in sql_files:
    try:
      query = configure_sql(sql_file, query_params)
      query_job = client.query(query, location=location)
      query_job.result()
    except:
      logging.exception('Error in %s', sql_file)
      raise


def get_main_workflow_sql(project_id: str, dataset_id: str, merchant_id: str,
                          customer_id: str) -> str:
  """Returns main workflow sql.

  Args:
    project_id: A cloud project id.
    dataset_id: BigQuery dataset id.
    merchant_id: Merchant center id.
    customer_id: Google Ads customer id.
  """
  query_params = {
      'project_id': project_id,
      'dataset': dataset_id,
      'merchant_id': merchant_id,
      'external_customer_id': customer_id
  }
  return configure_sql(_MAIN_WORKFLOW_SQL, query_params)


def get_best_sellers_workflow_sql(project_id: str, dataset_id: str,
                                  merchant_id: str) -> str:
  """Returns main workflow sql.

  Args:
    project_id: A cloud project id.
    dataset_id: BigQuery dataset id.
    merchant_id: Merchant center id.
  """
  query_params = {
      'project_id': project_id,
      'dataset': dataset_id,
      'merchant_id': merchant_id
  }
  return configure_sql(_BEST_SELLERS_WORKFLOW_SQL, query_params)
