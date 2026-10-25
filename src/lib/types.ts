import type { ScreeningStatus } from './screening-types';

export type RequestStatus = 'New' | 'In review' | 'Scheduled' | 'Completed' | 'Referred';
export type Priority = 'Low' | 'Medium' | 'High';
export interface Attachment { id: string; name: string; type: string; size: number; url: string; }
export interface CaseNote { id: string; text: string; createdAt: string; }
export interface CaseSource {
  label: string;
  reportUrl: string;
  storyUrl: string;
  timelineUrl: string;
  pricePaid: string;
  estimate: string;
  findings: string[];
  recommendations: string[];
  timeline: { when_eastern: string; step: string; system: string; what: string }[];
  discrepancies: string[];
}
export interface InspectionRequest {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  postalCode: string;
  propertyType: string;
  area: string;
  size: string;
  duration: string;
  description: string;
  signs: string[];
  contactPreference: string;
  consent: boolean;
  status: RequestStatus;
  priority: Priority;
  createdAt: string;
  updatedAt: string;
  assignee: string;
  scheduledAt: string;
  attachments: Attachment[];
  notes: CaseNote[];
  isDemo?: boolean;
  relationship?: string;
  source?: CaseSource;
  screening?: { id: string; reference: string; status: ScreeningStatus; reportAvailable: boolean };
}
export interface Contractor {
  id: string;
  name: string;
  initials: string;
  tagline: string;
  description: string;
  area: string;
  services: string[];
  phone: string;
  website: string;
  price: string;
  priceNote: string;
  availability: string;
  featured?: boolean;
  color: string;
  sourceUrl: string;
}
export type CustomerRequest = Omit<InspectionRequest, 'priority' | 'notes' | 'source'>;
export type Page = 'inspection' | 'screening' | 'requests' | 'admin' | 'contractors' | 'login';
export interface PageProps { onNavigate: (page: Page) => void; }
