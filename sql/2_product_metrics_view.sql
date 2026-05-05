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

# Creates a snapshot of product_metrics_view.
#
# The ads_ShoppingProductStats_<External Customer Id> table has shopping performance metrics.
# This view will get latest metrics data and create derived columns useful for further processing of
# data.

CREATE OR REPLACE VIEW `{project_id}.{dataset}.product_metrics_view`
AS (
  WITH
    GeoTargets AS (
      SELECT DISTINCT
        criteria_id,
        country_code
      FROM
        `{project_id}.{dataset}.geo_targets`
    ),
    LanguageCodes AS (
      SELECT DISTINCT
        criterion_id,
        language_code
      FROM
        `{project_id}.{dataset}.language_codes`
    ),
    -- 1. Calculate clicks per campaign per country
    CampaignGeoClicks AS (
      SELECT
        campaign_id,
        GeoTargets.country_code,
        SUM(metrics_clicks) AS total_clicks,
        SUM(SUM(metrics_clicks)) OVER(PARTITION BY campaign_id) AS campaign_total_clicks
      FROM `{project_id}.{dataset}.ads_GeoStats_*` AS GeoStats
      INNER JOIN GeoTargets
        ON GeoStats.geographic_view_country_criterion_id = GeoTargets.criteria_id
      WHERE _TABLE_SUFFIX IN ({external_customer_id})
      GROUP BY 1, 2
    ),
    
    -- 2. Find the winner country (most clicks)
    CampaignWinnerCountry AS (
      SELECT * EXCEPT(row_num)
      FROM (
        SELECT
          campaign_id,
          country_code AS winner_country,
          ROW_NUMBER() OVER(PARTITION BY campaign_id ORDER BY total_clicks DESC) AS row_num
        FROM CampaignGeoClicks
      )
      WHERE row_num = 1
    ),
    
    -- 3. Create the share list string
    CampaignGeoShare AS (
      SELECT
        campaign_id,
        STRING_AGG(CONCAT(country_code, ': ', ROUND(SAFE_DIVIDE(total_clicks, campaign_total_clicks) * 100, 1), '%'), ', ') AS country_shares
      FROM CampaignGeoClicks
      GROUP BY 1
    ),
    
    ShoppingProductStats AS (
      SELECT
        _DATA_DATE,
        _LATEST_DATE,
        customer_id,
        campaign_id,
        segments_product_merchant_id AS merchant_id,
        segments_product_channel AS channel,
        segments_product_item_id AS offer_id,
        CAST(SPLIT(segments_product_language, '/')[SAFE_OFFSET(1)] AS INT64) AS language_criterion_id,
        metrics_impressions AS impressions,
        metrics_clicks AS clicks,
        metrics_cost_micros AS cost,
        metrics_conversions AS conversions,
        metrics_conversions_value AS conversions_value
      FROM
        `{project_id}.{dataset}.ads_ShoppingProductStats_*`
      WHERE
        _TABLE_SUFFIX IN ({external_customer_id})
    )
    
  SELECT
    ShoppingProductStats._DATA_DATE,
    ShoppingProductStats._LATEST_DATE,
    ShoppingProductStats.customer_id,
    ShoppingProductStats.merchant_id,
    ShoppingProductStats.channel,
    ShoppingProductStats.offer_id,
    LanguageCodes.language_code,
    -- Use campaign winner country if segments_product_country was null
    COALESCE(CampaignWinnerCountry.winner_country, 'unknown') AS target_country,
    ANY_VALUE(CampaignGeoShare.country_shares) AS country_shares,
    SUM(ShoppingProductStats.impressions) AS impressions,
    SUM(ShoppingProductStats.clicks) AS clicks,
    SAFE_DIVIDE(SUM(ShoppingProductStats.cost), 1e6) AS cost,
    SUM(ShoppingProductStats.conversions) AS conversions,
    SUM(ShoppingProductStats.conversions_value) AS conversions_value
  FROM ShoppingProductStats
  LEFT JOIN LanguageCodes
    ON LanguageCodes.criterion_id = ShoppingProductStats.language_criterion_id
  LEFT JOIN CampaignWinnerCountry
    ON CampaignWinnerCountry.campaign_id = ShoppingProductStats.campaign_id
  LEFT JOIN CampaignGeoShare
    ON CampaignGeoShare.campaign_id = ShoppingProductStats.campaign_id
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
);
