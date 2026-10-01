# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Elite Kitchens staff handling customer WhatsApp conversations at their desks and on phones. The business makes bespoke kitchens, wardrobes and utility rooms in Ireland.

## Product Purpose

A central business workspace, beginning with the working Phase 2 customer inbox. Success means staff can quickly find a customer, reply, retrieve shared photos or plans, and maintain customer details.

## Operating Context

Daily desktop use is primary; the phone experience uses separate inbox, conversation and customer screens. The existing Firebase project and WhatsApp Cloud API process real customer data. Preview Hosting shares that backend.

## Capabilities and Constraints

Preserve text, templates, photos, video, audio, documents, attachments, captions, statuses, unread counts, search, customer editing/deletion, private media, authentication and mobile navigation. Customer profile sections are Details, Media and Documents.

Plain HTML/CSS/JavaScript in public/ with no build step. Backend functions, payloads, data shapes, auth/storage architecture, rules, retention, secrets and deployment infrastructure are locked. Work on phase-2-ui-redesign. Deploy Hosting preview only; no production deployment or main merge without the owner's explicit approval. Recovery tags must not move.

Leads, pipeline, appointments, quotations, projects and AI are future scope and must not be fabricated in this redesign.

## Brand Commitments

Premium, calm, light business software with off-white neutral surfaces, charcoal typography, restrained navigation and sparse intentional colour. The user's attached reference establishes visual language rather than an exact layout. Avoid gradients, excessive shadows, nested cards and indiscriminate rounding.

The owner supplied the black transparent Elite Kitchens logo. Compact branding uses its original E and K lettering, not a substitute typeface or the full logo squeezed into the navigation rail.

## Evidence on Hand

Working frontend, Phase 2 hand-off documents, 51 emulator browser checks (45 foundation and six first-redesign checks), and test-ui/shots/. Screenshot content is synthetic test data, not customer evidence.

## Product Principles

- Reliability and familiar messaging behavior come first.
- Give customer communication and media priority over application chrome.
- Derive customer assets from existing messages and private-media contracts.
- Keep future tools distinct from working functionality.
- Make changes reviewable on a separate preview.

## Accessibility & Inclusion

Readable text and contrast, keyboard focus, adequate tap targets, and practical desktop/tablet/phone layouts.
