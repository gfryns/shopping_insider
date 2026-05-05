/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** @fileoverview The constants and functions for Shopping Insider. */

/** @type {string} Http url base for SQL files. */
const SOURCE_REPO = 'https://raw.githubusercontent.com/gfryns/shopping_insider/multi-accounts';

/** Definition of the Looker dashboard. */
/** @type {string} Looker dashboard Id. */
const LOOKER_ID = 'f1859d41-b693-470c-a404-05c585f51f20';
/** @type {!Array<Object>} Data sources used in Looker dashboard. */
const LOOKER_DATA_SOURCES = [
  {
    connector: 'bigQuery',
    type: 'TABLE',
    projectId: '${projectId}',
    datasetId: '${dataset}',
    keepDatasourceName: 'true',
    aliases: {
      product_detailed: { tableId: 'product_detailed_materialized' },
      product_historical: { tableId: 'product_historical_materialized' },
    },
  },
];

/** Tables will be transferred through Google Ads Data Transfer. */
/** @type {!Array<string>} */
const GOOGLE_ADS_TABLES = [
  'Customer',
  'Campaign',
  'AdGroup',
  'AdGroupCriterion',
  'AssetGroup',
  'AssetGroupListingGroupFilter',
  'ShoppingProductStats',
  'GeoStats',
];

/**
 * The list of supported GMC DT BigQuery regions.
 * @see https://cloud.google.com/bigquery/docs/locations
 */
const GMC_BQ_DT_LOCATIONS = [
  { displayName: 'United States', locationId: 'US' },
  { displayName: 'European Union', locationId: 'EU' },
  { displayName: 'Tokyo', locationId: 'asia-northeast1' },
  { displayName: 'Singapore', locationId: 'asia-southeast1' },
  { displayName: 'Sydney', locationId: 'australia-southeast1' },
  { displayName: 'Finland', locationId: 'europe-north1' },
  { displayName: 'London', locationId: 'europe-west2' },
  { displayName: 'Zürich', locationId: 'europe-west6' },
  { displayName: 'Northern Virginia', locationId: 'us-east4' },
];

/**
 * Creates or updates a data transfer configuration.
 * @param {string} name Data transfer configuration name.
 * @param {Object} resource Object contains other optional information, e.g.
 *   versionInfo.
 * @return {!CheckResult}
 */
const createOrUpdateDataTransfer = (name, resource) => {
  const datasetId = getDocumentProperty('dataset');
  const versionInfo = resource.attributeValue;
  let allResults = [];

  if (name.startsWith('Merchant Center Transfer')) {
    const merchantIds = getDocumentProperty('merchantId').split(',').map(id => id.trim());
    for (const mId of merchantIds) {
      const config = {
        displayName: `Merchant Center Transfer - ${mId}`,
        destinationDatasetId: datasetId,
        dataSourceId: DATA_TRANSFER_SOURCE.GOOGLE_MERCHANT_CENTER,
        params: {
          merchant_id: mId,
          export_products: true,
          export_offer_targeting: true,
          export_regional_inventories: false,
          export_local_inventories: false,
        }
      };
      const filterFn = (transferConfig) => {
        return transferConfig.dataSourceId === config.dataSourceId
          && transferConfig.destinationDatasetId === config.destinationDatasetId
          && transferConfig.params.merchant_id === config.params.merchant_id;
      };
      allResults.push(gcloud.createOrUpdateDataTransfer(config, datasetId, filterFn, versionInfo));
    }
  } else if (name.startsWith('Google Ads Transfer')) {
    const customerIds = getDocumentProperty('externalCustomerId').split(',').map(id => id.trim().replace(/-/g, ''));
    for (const cId of customerIds) {
      const config = {
        displayName: `Google Ads Transfer - ${cId}`,
        destinationDatasetId: datasetId,
        dataSourceId: DATA_TRANSFER_SOURCE.GOOGLE_ADS,
        dataRefreshWindowDays: 1,
        params: {
          table_filter: GOOGLE_ADS_TABLES.join(','),
          customer_id: cId,
          include_pmax: true,
        }
      };
      const filterFn = (transferConfig) => {
        return transferConfig.dataSourceId === config.dataSourceId
          && transferConfig.destinationDatasetId === config.destinationDatasetId
          && transferConfig.params.customer_id === config.params.customer_id;
      };
      allResults.push(gcloud.createOrUpdateDataTransfer(config, datasetId, filterFn, versionInfo));
    }
  } else {
    return {
      status: RESOURCE_STATUS.ERROR,
      message: `Unknown Data Transfer type: ${name}`,
    };
  }
  
  const errorResult = allResults.find(r => r.status !== RESOURCE_STATUS.OK);
  return errorResult || allResults[0];
}

/**
 * Custom parameter replacer to handle multiple IDs for SQL IN clauses.
 */const customReplaceSqlParams = (sql, params) => {
  const formattedParams = Object.assign({}, params);
  
  const merchantId = params.merchantId || params.merchant_id;
  if (merchantId) {
    const ids = merchantId.split(',').map(id => `'${id.trim()}'`);
    const quotedList = `${ids.join(', ')}`;
    formattedParams.merchant_id = quotedList;
    formattedParams.merchantId = quotedList;
  }
  
  const externalCustomerId = params.externalCustomerId || params.external_customer_id;
  if (externalCustomerId) {
    const ids = externalCustomerId.split(',').map(id => `'${id.trim().replace(/-/g, '')}'`);
    const quotedList = `${ids.join(', ')}`;
    formattedParams.external_customer_id = quotedList;
    formattedParams.externalCustomerId = quotedList;
  }
  if (params.dataset) {
    formattedParams.dataset = params.dataset;
  }
  if (params.projectId) {
    formattedParams.project_id = params.projectId;
  }
  
  // Handle wildcard tables on views by generating UNION ALL or specific table references.
  // This avoids "Views cannot be queried through prefix" error in BigQuery.
  let sqlScript = sql;
  const rawMerchantIds = merchantId ? merchantId.split(',').map(id => id.trim()) : [];
  const rawCustomerIds = externalCustomerId ? externalCustomerId.split(',').map(id => id.trim().replace(/-/g, '')) : [];

  if (rawMerchantIds.length > 0 || rawCustomerIds.length > 0) {
    const replacer = (match, tableBase, alias) => {
      let ids = [];
      if (tableBase.startsWith('ads_')) {
        ids = rawCustomerIds;
      } else {
        ids = rawMerchantIds;
      }
      
      if (ids.length === 0) return match;
      
      const subqueries = [];
      for (const cid of ids) {
        if (!tableBase.startsWith('ads_')) {
          subqueries.push(
              `SELECT *, _PARTITIONTIME, '${cid}' as cid FROM \`${params.projectId}.${params.dataset}.${tableBase}_${cid}\``
          );
        } else {
          subqueries.push(
              `SELECT *, '${cid}' as _TABLE_SUFFIX FROM \`${params.projectId}.${params.dataset}.${tableBase}_${cid}\``
          );
        }
      }
      
      if (alias) {
        return "(" + subqueries.join(" UNION ALL ") + ") AS " + alias;
      } else {
        return "(" + subqueries.join(" UNION ALL ") + ") AS " + tableBase + "_source";
      }
    };

    const regex = /`\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)_\*`(?:\s+AS\s+([a-zA-Z0-9_]+))?/g;
    sqlScript = sqlScript.replace(regex, replacer);
  }
  
  const match = sqlScript.match(/CREATE OR REPLACE VIEW `\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)`/);
  let ids = [];
  let viewName = '';
  const gmcViews = ['product_view'];
  const adsViews = ['product_metrics_view', 'customer_view', 'adgroup_criteria_view', 'pmax_criteria_view', 'criteria_view', 'targeted_products_view', 'product_detailed_view'];

  if (match) {
    viewName = match[1];
    if (viewName === 'product_view') {
      ids = rawMerchantIds;
    } else {
      ids = rawCustomerIds.length > 0 ? rawCustomerIds : rawMerchantIds;
    }
  } else {
    ids = rawCustomerIds.length > 0 ? rawCustomerIds : rawMerchantIds;
  }

  if (ids.length > 0) {
    const scripts = [];
    
    // 1. Create suffixed views for each account
    for (let i = 0; i < ids.length; i++) {
      const cid = ids[i];
      let instanceScript = sqlScript;
      
      // Replace view name in CREATE VIEW
      instanceScript = instanceScript.replace(/CREATE OR REPLACE VIEW `\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)`/g, `CREATE OR REPLACE VIEW \`{project_id}.{dataset}.$1_${cid}\``);
      
      // Replace references to GMC views
      for (const view of gmcViews) {
        const viewRegex = new RegExp('`\\{project_id\\}\\.\\{dataset\\}\\.' + view + '`', 'g');
        const targetId = rawMerchantIds.length > 0 ? rawMerchantIds[i % rawMerchantIds.length] : cid;
        instanceScript = instanceScript.replace(viewRegex, `\`{project_id}.{dataset}.${view}_${targetId}\``);
      }
      
      // Replace references to Ads views
      for (const view of adsViews) {
        const viewRegex = new RegExp('`\\{project_id\\}\\.\\{dataset\\}\\.' + view + '`', 'g');
        const targetId = rawCustomerIds[i] || cid;
        instanceScript = instanceScript.replace(viewRegex, `\`{project_id}.{dataset}.${view}_${targetId}\``);
      }
      
      scripts.push(instanceScript.trim().replace(/;$/, ''));
    }
    
    // 2. Create a combined unsuffixed view as UNION ALL of the suffixed views
    const match = sqlScript.match(/CREATE OR REPLACE VIEW `\{project_id\}\.\{dataset\}\.([a-zA-Z0-9_]+)`/);
    if (match) {
      const baseViewName = match[1];
      const unionQueries = ids.map(cid => `SELECT * FROM \`{project_id}.{dataset}.${baseViewName}_${cid}\``);
      const unionSql = `CREATE OR REPLACE VIEW \`{project_id}.{dataset}.${baseViewName}\` AS\n${unionQueries.join("\nUNION ALL\n")}`;
      scripts.push(unionSql);
    }
    
    sqlScript = scripts.join(";\n") + ";";
  }
  
  return replacePythonStyleParameters(sqlScript, formattedParams);
}

/**
 * Escapes a string for use in a regular expression.
 */
const escapeRegExp = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Expands table names that contain comma-separated IDs into a full list of table names.
 * Example: "Products_123, 456" becomes "Products_123, Products_456"
 */
const fixRawTableNames = (tablesString) => {
  if (!tablesString) return tablesString;
  
  const tables = tablesString.split(',').map(t => t.trim());
  const resultTables = [];
  let currentPrefix = '';
  
  for (const t of tables) {
    if (t.includes('_')) {
      const parts = t.split('_');
      const idPart = parts[parts.length - 1];
      if (/^[0-9-]+$/.test(idPart)) {
        currentPrefix = parts.slice(0, parts.length - 1).join('_') + '_';
        const cleanId = idPart.replace(/-/g, '');
        resultTables.push(currentPrefix + cleanId);
      } else {
        resultTables.push(t);
        currentPrefix = '';
      }
    } else if (/^[0-9-]+$/.test(t)) {
      if (currentPrefix) {
        const cleanId = t.replace(/-/g, '');
        resultTables.push(currentPrefix + cleanId);
      } else {
        resultTables.push(t);
      }
    } else {
      resultTables.push(t);
      currentPrefix = '';
    }
  }
  
  return resultTables.join(', ');
};

/**
 * Creates or updates a scheduled query.
 * @param {string} name Scheduled query configuration name.
 * @param {Object} resource Object contains other optional information, e.g.
 *   versionInfo.
 * @return {!CheckResult}
 */
const createOrUpdateScheduledQuery = (name, resource) => {
  const datasetId = getDocumentProperty('dataset');
  const [displayName, sql] = name.split('\n');
  const versionInfo = resource.attributeValue;
  const query = getExecutableSql(`${SOURCE_REPO}/sql/${sql}`,
    PropertiesService.getDocumentProperties().getProperties(),
    customReplaceSqlParams
  );
  return gcloud.createOrUpdateScheduledQuery(
    displayName, datasetId, query, versionInfo);
}

/**
 * Loads a CSV file to a BigQuery table.
 * @param {string} tableName BigQuery table name.
 * @param {Object} resource Object contains the CSV file information.
 * @return {!CheckResult}
 */
const loadCsvToBigQuery = (tableName, resource) => {
  const url = `${SOURCE_REPO}/data/${resource.attributeValue}`;
  const response = UrlFetchApp.fetch(url);
  const status = response.getResponseCode();
  if (status >= 400) {
    return {
      status: RESOURCE_STATUS.ERROR,
      message: `Failed to get resource, HTTP status code: ${status}`,
    };
  }
  const data = response.getContentText();
  const datasetId = getDocumentProperty('dataset');
  return gcloud.loadDataToBigQuery(tableName, data, datasetId);
}

/**
 * Run a sql file to create BigQuery views.
 * @param {string} sql Sql file name.
 * @param {Object} resource Object contains other optional information, e.g.
 *   tables should exist before this query.
 * @return {!CheckResult}
 */
const createBigQueryViews = (sql, resource) => {
  const datasetId = getDocumentProperty('dataset');
  const url = `${SOURCE_REPO}/sql/${sql}`;
  const fixedResource = Object.assign({}, resource, {
    attributeValue: fixRawTableNames(resource.attributeValue)
  });
  return gcloud.createBigQueryViews(
    url, fixedResource, datasetId, customReplaceSqlParams);
}

/**
 * Creates dummy views to satisfy the framework's dependency check.
 */
const createDummyViews = (name, resource) => {
  const datasetId = getDocumentProperty('dataset');
  const url = `${SOURCE_REPO}/sql/1_product_view.sql`; // Any valid file
  
  const dummyReplacer = () => {
    const customerIds = getDocumentProperty('externalCustomerId').split(',').map(id => id.trim().replace(/-/g, ''));
    const projectId = getDocumentProperty('projectId');
    
    let dummySql = '';
    for (const cid of customerIds) {
      dummySql += `CREATE OR REPLACE VIEW \`${projectId}.${datasetId}.adgroup_criteria_view_${cid}\` AS SELECT * FROM \`${projectId}.${datasetId}.adgroup_criteria_view\`;\n`;
      dummySql += `CREATE OR REPLACE VIEW \`${projectId}.${datasetId}.pmax_criteria_view_${cid}\` AS SELECT * FROM \`${projectId}.${datasetId}.pmax_criteria_view\`;\n`;
    }
    return dummySql;
  };
  
  return gcloud.createBigQueryViews(url, resource, datasetId, dummyReplacer);
}

/**
 * Checks whether the expected BigQuery tables/views exist.
 * @param {string} _ Not usesd here. This function inhabits the arguement
 *   structure from the Cyborg framework.
 * @param {Object} resource Object contains other optional information, e.g.
 *   tables should exist before this query.
 * @return {!CheckResult}
 */
const checkExpectedTables = (_, resource) => {
  const datasetId = getDocumentProperty('dataset');
  const fixedAttributeValue = fixRawTableNames(resource.attributeValue);
  const result = gcloud.checkExpectedTables(fixedAttributeValue, datasetId);
  if (result.status !== RESOURCE_STATUS.OK) {
    return Object.assign({ value: 'Available after installation' }, result);
  }
  const dashboardLink = getLookerCreateLink(LOOKER_ID, LOOKER_DATA_SOURCES);
  return Object.assign({
    value: 'Click here to make a copy of the dashboard',
    value_link: dashboardLink,
  }, result);
}

/**
 * Register two Mojo templates for 'BigQuery Data Table' and 'BigQuery Views'
 * so they can be reused in the solution definition.
 * 'MOJO_CONFIG_TEMPLATE' is part of the framework Cyborg.
 */
MOJO_CONFIG_TEMPLATE.bigQueryDataTable = {
  category: 'Solution',
  resource: 'BigQuery Data Table',
  editType: RESOURCE_EDIT_TYPE.READONLY,
  attributeName: 'Source',
  checkFn: loadCsvToBigQuery,
};
MOJO_CONFIG_TEMPLATE.bigQueryView = {
  category: 'Solution',
  resource: 'BigQuery Views',
  editType: RESOURCE_EDIT_TYPE.READONLY,
  attributeName: 'Expected table(s)',
  checkFn: createBigQueryViews,
};

/**
 * Clean up account number list.
 * @param {string} e Account number list.
 * @return {!CheckResult}
 */
const cleanAccountNumberList = (e) => {
  if (!/^[0-9][0-9-]*[0-9](?:\s*,\s*[0-9][0-9-]*[0-9])*$/.test(e)) {
    return {
      status: RESOURCE_STATUS.ERROR,
      message:
        "Only digits and dash(-) are allowed in account IDs. They must be separated by commas.",
    };
  }
  return {
    status: RESOURCE_STATUS.OK,
    value: e.replaceAll("-", ""),
  };
};

/** Solution configurations for Shopping Insider. */
const SHOPPING_INSIDER_MOJO_CONFIG = {
  sheetName: 'Shopping Insider',
  config: [
    { template: 'namespace', value: 'insider' },
    {
      template: 'parameter',
      category: 'General',
      resource: 'GMC Account Id',
      propertyName: 'merchantId',
      checkFn: cleanAccountNumberList,
    },
    // {
    //   category: 'General',
    //   resource: 'Market Insights',
    //   value: 'Enable',
    //   propertyName: 'marketInsight',
    //   propertyTarget: 'enable',
    //   optionalType: OPTIONAL_TYPE.DEFAULT_CHECKED,
    //   group: 'marketInsights',
    // },
    {
      template: 'parameter',
      category: 'General',
      resource: 'Google Ads MCC',
      propertyName: 'externalCustomerId',
      checkFn: cleanAccountNumberList,
    },
    { template: 'projectId' },
    {
      template: 'permissions',
      value: [
        'bigquery.datasets.create',
        'serviceusage.services.enable',
      ],
    },
    {
      category: 'Google Cloud',
      resource: 'APIs',
      value: [
        'BigQuery Data Transfer API',
      ],
      editType: RESOURCE_EDIT_TYPE.READONLY,
      checkFn: gcloud.checkOrEnableApi,
    },
    {
      template: 'bigQueryDataset',
      value: '${namespace}_dataset',
      attributes: [
        {
          attributeName: ATTRIBUTE_NAMES.bigquery.location,
          attributeValue_datarange: GMC_BQ_DT_LOCATIONS.map(getLocationListName),
        },
        {
          attributeName: ATTRIBUTE_NAMES.bigquery.partitionExpiration,
          attributeValue: 60
        }
      ],
      propertyName: 'dataset',
    },
    {
      category: 'Solution',
      resource: 'Data Transfer',
      value: [
        'Merchant Center Transfer - ${merchantId}',
        'Google Ads Transfer - ${externalCustomerId}',
      ],
      editType: RESOURCE_EDIT_TYPE.READONLY,
      attributeName: 'Version Info',
      checkFn: createOrUpdateDataTransfer,
    },
    {
      template: 'bigQueryDataTable',
      value: 'language_codes',
      attributeValue: 'language_codes.csv',
      attributeValue_link: `${SOURCE_REPO}/data/language_codes.csv`,
    },
    {
      template: 'bigQueryDataTable',
      value: 'geo_targets',
      attributeValue: 'geo_targets.csv',
      attributeValue_link: `${SOURCE_REPO}/data/geo_targets.csv`,
    },
    {
      template: 'bigQueryView',
      value: '1_product_view.sql',
      value_link: `${SOURCE_REPO}/sql/1_product_view.sql`,
      attributeValue: 'Products_${merchantId}',
    },
    {
      template: 'bigQueryView',
      value: '2_product_metrics_view.sql',
      value_link: `${SOURCE_REPO}/sql/2_product_metrics_view.sql`,
      attributeValue:
        'geo_targets, language_codes, ads_ShoppingProductStats_${externalCustomerId}',
    },
    {
      template: 'bigQueryView',
      value: '3_customer_view.sql',
      value_link: `${SOURCE_REPO}/sql/3_customer_view.sql`,
      attributeValue: 'ads_Customer_${externalCustomerId}',
    },
    {
      template: 'bigQueryView',
      value: '4_adgroup_criteria_view.sql',
      value_link: `${SOURCE_REPO}/sql/4_adgroup_criteria_view.sql`,
      attributeValue:
        'ads_Campaign_${externalCustomerId}, ads_AdGroup_${externalCustomerId}, ads_AdGroupCriterion_${externalCustomerId}',
    },
    {
      template: 'bigQueryView',
      value: '5_pmax_criteria_view.sql',
      value_link: `${SOURCE_REPO}/sql/5_pmax_criteria_view.sql`,
      attributeValue:
        'ads_AssetGroup_${externalCustomerId}, ads_AssetGroupListingGroupFilter_${externalCustomerId}',
    },
    {
      category: 'Solution',
      resource: 'BigQuery Views',
      value: 'Create Dummy Views for Multi-Account',
      editType: RESOURCE_EDIT_TYPE.READONLY,
      checkFn: createDummyViews,
    },
    // NOTE: The following views (6-9) have empty attributeValue to bypass the framework's
    // automatic account suffix addition for dependencies. The framework expects account-specific
    // views (e.g., adgroup_criteria_view_123), but these are single views for all accounts.
    // To satisfy the dependency check, create dummy views with the suffixes in BigQuery
    // that select from the main unsuffixed views.
    {
      template: 'bigQueryView',
      value: '6_criteria_view.sql',
      value_link: `${SOURCE_REPO}/sql/6_criteria_view.sql`,
      attributeValue: '',
    },
    {
      template: 'bigQueryView',
      value: '7_targeted_products_view.sql',
      value_link: `${SOURCE_REPO}/sql/7_targeted_products_view.sql`,
      attributeValue: '',
    },
    {
      template: 'bigQueryView',
      value: '8_product_detailed_view.sql',
      value_link: `${SOURCE_REPO}/sql/8_product_detailed_view.sql`,
      attributeValue: '',
    },
    {
      template: 'bigQueryView',
      value: '9_materialize_product_detailed.sql',
      value_link: `${SOURCE_REPO}/sql/9_materialize_product_detailed.sql`,
      attributeValue: '',
    },
    {
      template: 'bigQueryView',
      value: '10_materialize_product_historical.sql',
      value_link: `${SOURCE_REPO}/sql/10_materialize_product_historical.sql`,
    },
    // {
    //   template: 'bigQueryView',
    //   value: 'market_insights/snapshot_view.sql',
    //   attributeValue: 'product_detailed_materialized, Products_PriceBenchmarks_${merchantId}, BestSellers_TopProducts_Inventory_${merchantId}',
    //   group: 'marketInsights',
    // },
    // {
    //   template: 'bigQueryView',
    //   value: 'market_insights/historical_view.sql',
    //   attributeValue: 'Products_${merchantId}, Products_PriceBenchmarks_${merchantId}',
    //   group: 'marketInsights',
    // },
    {
      category: 'Solution',
      resource: 'Scheduled Query',
      value: 'Main workflow - ${dataset} - ${externalCustomerId}\nmain_workflow.sql',
      editType: RESOURCE_EDIT_TYPE.READONLY,
      attributeName: 'Version Info',
      checkFn: createOrUpdateScheduledQuery,
    },
    // {
    //   category: 'Solution',
    //   resource: 'Scheduled Query',
    //   value: 'Best sellers workflow - ${dataset} - ${merchantId}\nmarket_insights/best_sellers_workflow.sql',
    //   editType: RESOURCE_EDIT_TYPE.READONLY,
    //   attributeName: 'Version Info',
    //   checkFn: createOrUpdateScheduledQuery,
    //   group: 'marketInsights',
    // },
    {
      category: 'Solution',
      resource: 'Dashboard Template',
      editType: RESOURCE_EDIT_TYPE.READONLY,
      value: 'Available after installation',
      attributeName: 'Expected table(s)',
      attributeValue: getRequiredTablesForLooker(LOOKER_DATA_SOURCES),
      checkFn: checkExpectedTables,
    }
  ],
  headlineStyle: {
    backgroundColor: '#202124',
    fontColor: 'white',
  },
};

/**
 * The solution menus. 'SOLUTION_MENUS' is part of Cyborg framework.
 */
const SOLUTION_MENUS = [
  new MojoSheet(SHOPPING_INSIDER_MOJO_CONFIG),
  EXPLICIT_AUTH_MENUITEM,
];
