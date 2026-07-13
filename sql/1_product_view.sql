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

# Creates a snapshot of product_view.
#
# The Products_<Merchant Id> table has product data partitioned by date.
# This view will get latest product data and create derived columns useful for further processing of
# data.

CREATE OR REPLACE VIEW `{project_id}.{dataset}.product_view`
AS (
  WITH
    Products AS (
      SELECT
        *, _PARTITIONTIME AS _PARTITIONTIME_COL
       FROM `{project_id}.{dataset}.Products_*`
      WHERE cid IN ({merchant_id})
    ),
    LatestDate AS (
      SELECT
        MAX(DATE(_PARTITIONTIME)) AS latest_date
      FROM `{project_id}.{dataset}.Products_*`
      WHERE cid IN ({merchant_id})
    ),
    ProductStatus AS (
      SELECT
        DATE(Products._PARTITIONTIME_COL) AS _DATA_DATE,
        LatestDate.latest_date AS _LATEST_DATE,
        Products.product_id,
        Products.merchant_id,
        Products.aggregator_id,
        Products.offer_id,
        Products.feed_label,
        Products.product_data_timestamp,
        Products.title,
        Products.description,
        Products.link,
        Products.mobile_link,
        Products.image_link,
        Products.additional_image_links,
        Products.content_language,
        dest_country AS target_country,
        destination.name AS destination_name,
        Products.channel,
        Products.expiration_date,
        Products.google_expiration_date,
        Products.adult,
        Products.age_group,
        Products.availability,
        Products.availability_date,
        Products.brand,
        Products.color,
        Products.condition,
        Products.custom_labels,
        Products.gender,
        Products.gtin,
        Products.item_group_id,
        Products.material,
        Products.mpn,
        Products.pattern,
        Products.price,
        Products.sale_price,
        Products.sale_price_effective_start_date,
        Products.sale_price_effective_end_date,
        Products.google_product_category,
        Products.google_product_category_path,
        Products.product_type,
        Products.additional_product_types,
        IF(dest_country IN UNNEST(destination.approved_countries), 1, 0) AS is_approved,
        CONCAT(CAST(Products.merchant_id AS STRING), '|', Products.product_id)
          AS unique_product_id,
        CONCAT(CAST(Products.merchant_id AS STRING), '|', Products.offer_id)
          AS unique_offer_id,
        IFNULL(SPLIT(Products.product_type, '>')[SAFE_OFFSET(0)], 'N/A') AS product_type_l1,
        IFNULL(SPLIT(Products.product_type, '>')[SAFE_OFFSET(1)], 'N/A') AS product_type_l2,
        IFNULL(SPLIT(Products.product_type, '>')[SAFE_OFFSET(2)], 'N/A') AS product_type_l3,
        IFNULL(SPLIT(Products.product_type, '>')[SAFE_OFFSET(3)], 'N/A') AS product_type_l4,
        IFNULL(SPLIT(Products.product_type, '>')[SAFE_OFFSET(4)], 'N/A') AS product_type_l5,
        IFNULL(SPLIT(Products.google_product_category_path, '>')[SAFE_OFFSET(0)], 'N/A')
          AS google_product_category_l1,
        IFNULL(SPLIT(Products.google_product_category_path, '>')[SAFE_OFFSET(1)], 'N/A')
          AS google_product_category_l2,
        IFNULL(SPLIT(Products.google_product_category_path, '>')[SAFE_OFFSET(2)], 'N/A')
          AS google_product_category_l3,
        IFNULL(SPLIT(Products.google_product_category_path, '>')[SAFE_OFFSET(3)], 'N/A')
          AS google_product_category_l4,
        IFNULL(SPLIT(Products.google_product_category_path, '>')[SAFE_OFFSET(4)], 'N/A')
          AS google_product_category_l5,
        IF(Products.availability = 'in stock', 1, 0) AS in_stock,
        IF(MIN(Products.channel) OVER(PARTITION BY DATE(Products._PARTITIONTIME_COL), Products.merchant_id, Products.product_id)
           != MAX(Products.channel) OVER(PARTITION BY DATE(Products._PARTITIONTIME_COL), Products.merchant_id, Products.product_id),
           'multi_channel', 'single_channel') AS channel_exclusivity,
        Products.issues
      FROM
        Products,
        LatestDate,
        UNNEST(Products.destinations) AS destination,
        UNNEST(ARRAY_CONCAT(destination.approved_countries, destination.pending_countries, destination.disapproved_countries)) AS dest_country
      WHERE destination.name IS NOT NULL
    )
  SELECT
    ProductStatus.* EXCEPT(issues),
    (
      SELECT STRING_AGG(DISTINCT issue.short_description, ', ')
      FROM UNNEST(ProductStatus.issues) AS issue
      WHERE LOWER(issue.servability) = 'disapproved'
        AND (ProductStatus.target_country IN UNNEST(issue.applicable_countries) OR ARRAY_LENGTH(issue.applicable_countries) = 0)
    ) AS disapproval_issues,
    (
      SELECT STRING_AGG(DISTINCT issue.short_description, ', ')
      FROM UNNEST(ProductStatus.issues) AS issue
      WHERE LOWER(issue.servability) = 'demoted'
        AND (ProductStatus.target_country IN UNNEST(issue.applicable_countries) OR ARRAY_LENGTH(issue.applicable_countries) = 0)
    ) AS demotion_issues,
    (
      SELECT STRING_AGG(DISTINCT issue.short_description, ', ')
      FROM UNNEST(ProductStatus.issues) AS issue
      WHERE LOWER(issue.servability) = 'unaffected'
        AND (ProductStatus.target_country IN UNNEST(issue.applicable_countries) OR ARRAY_LENGTH(issue.applicable_countries) = 0)
    ) AS warning_issues
  FROM
    ProductStatus
);
