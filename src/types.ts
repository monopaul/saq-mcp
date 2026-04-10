export interface SaqCredentials {
  apiKey: string;
  environmentId: string;
  storeCode: string;
  storeViewCode: string;
  websiteCode: string;
}

export interface ProductPrice {
  value: number;
  currency: string;
}

export interface ProductAttribute {
  code: string;
  value: string;
}

export interface SaqProduct {
  sku: string;
  name: string;
  url_key: string;
  url: string;
  thumbnail?: string;
  price: number;
  currency: string;
  regularPrice?: number;
  inStock?: boolean;
  // SAQ-specific attributes
  country?: string;
  region?: string;
  appellation?: string;
  grape?: string;
  format?: string;
  abv?: string;
  colour?: string;
  sugar?: string;
  producer?: string;
  vintage?: string;
  productType?: string;
  tasteProfile?: string;
  rating?: number;
  ratingCount?: number;
  availability?: string;
  storeIds?: string[];
  isNew?: boolean;
  releaseDate?: string;
  rawAttributes: ProductAttribute[];
}

export interface SearchResult {
  total_count: number;
  current_page: number;
  page_size: number;
  total_pages: number;
  products: SaqProduct[];
}

export interface StoreInfo {
  storeId: string;
  name: string;
  address: string;
  city: string;
  quantity: number;
  available: boolean;
}

export type AvailabilityFilter =
  | 'online'
  | 'inStore'
  | 'comingSoon'
  | 'lotteryCurrently'
  | 'lotterySoon'
  | 'soldOut'
  | 'unavailable';

export type SortField = 'relevance' | 'date_arrival' | 'price' | 'name';
export type SortDir = 'asc' | 'desc';

export type ProductCategory =
  | 'wine'
  | 'spirits'
  | 'beer'
  | 'champagne-and-sparkling-wine'
  | 'cider'
  | 'sake'
  | 'aperitif'
  | 'port-and-fortified-wine'
  | 'dessert-wine'
  | 'non-alcoholic';
