import type {
  SaqCredentials,
  SaqProduct,
  SearchResult,
  StoreInfo,
  AvailabilityFilter,
  SortField,
  SortDir,
  ProductCategory,
} from './types.js';

const CATALOG_URL = 'https://catalog-service.adobe.io/graphql';
const SAQ_BASE = 'https://www.saq.com';

// Guest customer group: SHA1("0")
const GUEST_CUSTOMER_GROUP = 'b6589fc6ab0dc82cf12099d1c2d40ab994e8410c';

// SAQ availability_front filter values (as displayed in UI)
const AVAILABILITY_FRONT: Record<AvailabilityFilter, string> = {
  online: 'Online',
  inStore: 'In store',
  comingSoon: 'Available shortly',
  lotteryCurrently: 'In a lottery',
  lotterySoon: 'In a lottery shortly',
  soldOut: 'Sold out',
  unavailable: 'Unavailable',
};

// All "currently purchasable" availability values
const AVAILABLE_NOW = ['Online', 'In store', 'In a lottery'];

// Category path format: "products/wine/red-wine"
const CATEGORY_PATHS: Record<ProductCategory, string> = {
  wine: 'products/wine',
  spirits: 'products/spirit',
  beer: 'products/beer',
  'champagne-and-sparkling-wine': 'products/champagne-and-sparkling-wine',
  cider: 'products/cider',
  sake: 'products/sake',
  aperitif: 'products/aperitif',
  'port-and-fortified-wine': 'products/port-and-fortified-wine',
  'dessert-wine': 'products/dessert-wine',
  'non-alcoholic': 'products/non-alcoholic',
};

const SEARCH_QUERY = /* graphql */ `
  query productSearch(
    $phrase: String!
    $pageSize: Int
    $currentPage: Int = 1
    $filter: [SearchClauseInput!]
    $sort: [ProductSearchSortInput!]
    $context: QueryContextInput
  ) {
    productSearch(
      phrase: $phrase
      page_size: $pageSize
      current_page: $currentPage
      filter: $filter
      sort: $sort
      context: $context
    ) {
      total_count
      items {
        ...Product
        ...ProductView
      }
      page_info {
        current_page
        page_size
        total_pages
      }
    }
  }

  fragment Product on ProductSearchItem {
    product {
      __typename
      sku
      name
      canonical_url
      thumbnail { url }
      price_range {
        minimum_price {
          final_price { value currency }
          regular_price { value currency }
          discount { percent_off amount_off }
        }
      }
    }
  }

  fragment ProductView on ProductSearchItem {
    productView {
      __typename
      sku
      name
      inStock
      url
      urlKey
      ... on SimpleProductView {
        attributes {
          label
          name
          value
        }
        price {
          final { amount { value currency } }
          regular { amount { value currency } }
        }
      }
    }
  }
`;

interface GraphQLAttribute {
  label: string;
  name: string;
  value: string;
}

interface GraphQLProductItem {
  product?: {
    sku: string;
    name: string;
    canonical_url?: string;
    thumbnail?: { url: string };
    price_range?: {
      minimum_price?: {
        final_price?: { value: number; currency: string };
        regular_price?: { value: number; currency: string };
        discount?: { percent_off: number; amount_off: number };
      };
    };
  };
  productView?: {
    sku: string;
    name: string;
    inStock?: boolean;
    url?: string;
    urlKey?: string;
    attributes?: GraphQLAttribute[];
    price?: {
      final?: { amount?: { value: number; currency: string } };
      regular?: { amount?: { value: number; currency: string } };
    };
  };
}

interface GraphQLSearchResponse {
  data?: {
    productSearch?: {
      total_count: number;
      page_info: {
        current_page: number;
        page_size: number;
        total_pages: number;
      };
      items: GraphQLProductItem[];
    };
  };
  errors?: Array<{ message: string }>;
}

function attrByName(attrs: GraphQLAttribute[], name: string): string | undefined {
  const val = attrs.find((a) => a.name === name)?.value;
  if (Array.isArray(val)) return (val as string[]).join(', ');
  return val ?? undefined;
}

function attrArrayByName(attrs: GraphQLAttribute[], name: string): string[] {
  const val = attrs.find((a) => a.name === name)?.value;
  if (Array.isArray(val)) return val as string[];
  if (val) return [val as string];
  return [];
}

function mapProduct(item: GraphQLProductItem): SaqProduct {
  const p = item.product;
  const pv = item.productView;
  const attrs: GraphQLAttribute[] = (pv as { attributes?: GraphQLAttribute[] })?.attributes ?? [];

  const sku = pv?.sku ?? p?.sku ?? '';
  const name = pv?.name ?? p?.name ?? '';
  const urlKey = pv?.urlKey ?? pv?.url?.split('/').pop() ?? '';
  const url = pv?.url ?? `${SAQ_BASE}/en/products/${urlKey}/${sku}`;
  const thumbnail = p?.thumbnail?.url;

  const price =
    (pv as { price?: { final?: { amount?: { value: number } } } })?.price?.final?.amount?.value ??
    p?.price_range?.minimum_price?.final_price?.value ??
    0;
  const currency =
    (pv as { price?: { final?: { amount?: { value: number; currency: string } } } })?.price?.final
      ?.amount?.currency ??
    p?.price_range?.minimum_price?.final_price?.currency ??
    'CAD';

  const regularPrice =
    (pv as { price?: { regular?: { amount?: { value: number } } } })?.price?.regular?.amount
      ?.value ?? p?.price_range?.minimum_price?.regular_price?.value;

  // Real SAQ attribute codes (discovered from live API)
  const availFront = attrArrayByName(attrs, 'availability_front');

  return {
    sku,
    name,
    url_key: urlKey,
    url,
    thumbnail,
    price,
    currency,
    regularPrice,
    inStock: pv?.inStock,
    country: attrByName(attrs, 'pays_origine'),
    region: attrByName(attrs, 'region_origine'),
    appellation: attrByName(attrs, 'appellation'),
    grape: attrByName(attrs, 'cepage_text') || attrByName(attrs, 'cepage'),
    format: attrByName(attrs, 'format_contenant_ml') ? `${attrByName(attrs, 'format_contenant_ml')} ml` : undefined,
    abv: attrByName(attrs, 'pourcentage_alcool_par_volume'),
    colour: attrByName(attrs, 'couleur'),
    sugar: attrByName(attrs, 'taux_sucre') ? `${attrByName(attrs, 'taux_sucre')} g/L` : undefined,
    producer: attrByName(attrs, 'nom_producteur'),
    vintage: attrByName(attrs, 'millesime_produit') || undefined,
    productType: attrByName(attrs, 'identite_produit'),
    tasteProfile: attrByName(attrs, 'pastille_gout'),
    rating: attrByName(attrs, 'reviews_average_rating')
      ? Number(attrByName(attrs, 'reviews_average_rating'))
      : undefined,
    ratingCount: attrByName(attrs, 'reviews_count_rating')
      ? Number(attrByName(attrs, 'reviews_count_rating'))
      : undefined,
    availability: availFront.length ? availFront.join(', ') : undefined,
    storeIds: attrArrayByName(attrs, 'store_availability_list'),
    isNew: attrByName(attrs, 'type_listing') === 'New arrival',
    releaseDate: attrByName(attrs, 'available_date_time'),
    rawAttributes: attrs.map((a) => ({ code: a.name, value: a.value })),
  };
}

type GqlFilter = { attribute: string; eq?: string; in?: string[]; range?: { from?: string; to?: string } };

export class SaqClient {
  constructor(private creds: SaqCredentials) {}

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.creds.apiKey,
      'Magento-Environment-Id': this.creds.environmentId,
      'Magento-Store-Code': this.creds.storeCode,
      'Magento-Store-View-Code': this.creds.storeViewCode,
      'Magento-Website-Code': this.creds.websiteCode,
    };
  }

  private async graphql(variables: Record<string, unknown>): Promise<GraphQLSearchResponse> {
    const res = await fetch(CATALOG_URL, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query: SEARCH_QUERY, variables }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}\n${body}`);
    }

    const json = (await res.json()) as GraphQLSearchResponse;
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
    }
    return json;
  }

  async searchProducts(options: {
    query?: string;
    category?: ProductCategory;
    availability?: AvailabilityFilter[];
    sortBy?: SortField;
    sortDir?: SortDir;
    page?: number;
    pageSize?: number;
    minPrice?: number;
    maxPrice?: number;
    country?: string;
    /** Filter by multiple countries of origin (uses OR logic, more efficient than multiple queries). */
    countries?: string[];
    region?: string;
    grape?: string;
    /** If true, show ALL availability statuses (including coming soon/lottery). Default: show only purchasable. */
    includeUnavailable?: boolean;
  }): Promise<SearchResult> {
    const {
      query = '',
      category,
      availability,
      sortBy = 'relevance',
      sortDir = 'desc',
      page = 1,
      pageSize = 24,
      minPrice,
      maxPrice,
      country,
      countries,
      region,
      grape,
      includeUnavailable = false,
    } = options;

    const filter: GqlFilter[] = [
      // Only regular products (not recipes, cocktails, blog, etc.)
      { attribute: 'catalog_type', in: ['1'] },
      // Standard visibility filter
      { attribute: 'visibility', in: ['Catalog', 'Catalog, Search'] },
    ];

    if (category) {
      filter.push({ attribute: 'categoryPath', eq: CATEGORY_PATHS[category] });
    }

    if (availability?.length) {
      filter.push({ attribute: 'availability_front', in: availability.map((a) => AVAILABILITY_FRONT[a]) });
    } else if (!includeUnavailable) {
      // Default: only show items that can be purchased or viewed
      filter.push({
        attribute: 'availability_front',
        in: [...AVAILABLE_NOW, 'In a lottery shortly'],
      });
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.push({ attribute: 'price', range: { from: minPrice?.toString(), to: maxPrice?.toString() } });
    }

    if (country) filter.push({ attribute: 'pays_origine', eq: country });
    if (countries?.length) filter.push({ attribute: 'pays_origine', in: countries });
    if (region) filter.push({ attribute: 'region_of_origin', eq: region });
    if (grape) filter.push({ attribute: 'grape_variety', eq: grape });

    let sort: Array<{ attribute: string; direction: string }>;
    if (sortBy === 'relevance') {
      sort = [{ attribute: 'position', direction: 'ASC' }];
    } else if (sortBy === 'date_arrival') {
      sort = [{ attribute: 'date_arrival', direction: sortDir.toUpperCase() }];
    } else {
      sort = [{ attribute: sortBy, direction: sortDir.toUpperCase() }];
    }

    const response = await this.graphql({
      phrase: query || '',
      pageSize,
      currentPage: page,
      filter,
      sort,
      context: {
        customerGroup: GUEST_CUSTOMER_GROUP,
        userViewHistory: [],
      },
    });

    const data = response.data?.productSearch;
    if (!data) throw new Error('No productSearch data in response');

    return {
      total_count: data.total_count,
      current_page: data.page_info.current_page,
      page_size: data.page_info.page_size,
      total_pages: data.page_info.total_pages,
      products: data.items.map(mapProduct),
    };
  }

  async getNewArrivals(options: {
    category?: ProductCategory;
    page?: number;
    pageSize?: number;
  } = {}): Promise<SearchResult> {
    return this.searchProducts({
      ...options,
      sortBy: 'date_arrival',
      sortDir: 'desc',
      includeUnavailable: false,
    });
  }

  async getComingSoon(options: {
    category?: ProductCategory;
    page?: number;
    pageSize?: number;
  } = {}): Promise<SearchResult> {
    return this.searchProducts({
      ...options,
      availability: ['comingSoon', 'lotterySoon'],
      sortBy: 'date_arrival',
      sortDir: 'asc',
      includeUnavailable: true,
    });
  }

  async getProductBySku(sku: string): Promise<SaqProduct | null> {
    // Normalize SKU: remove leading zeros for search, keep original for match
    const normalizedSku = sku.replace(/^0+/, '');
    const result = await this.searchProducts({
      query: normalizedSku,
      pageSize: 10,
      includeUnavailable: true,
    });
    return (
      result.products.find((p) => p.sku === sku || p.sku === normalizedSku || p.sku.replace(/^0+/, '') === normalizedSku) ??
      null
    );
  }

  async checkStoreAvailability(sku: string): Promise<StoreInfo[]> {
    // First get the product to extract the store_availability_list
    const product = await this.getProductBySku(sku);

    if (!product) {
      throw new Error(`Product not found: ${sku}`);
    }

    const storeIds = product.storeIds ?? [];

    if (!storeIds.length) {
      return [];
    }

    // The store_availability_list contains SAQ store IDs where this product is in stock.
    // Return them as StoreInfo with the IDs (names would require a separate store directory lookup).
    return storeIds.map((id) => ({
      storeId: id,
      name: `SAQ Store #${id}`,
      address: '',
      city: '',
      quantity: 1, // we know it's in stock, exact qty not provided at this level
      available: true,
    }));
  }
}
