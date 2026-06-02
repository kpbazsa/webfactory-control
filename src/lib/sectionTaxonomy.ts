// section_notes.section_type is NOT NULL with no CHECK constraint other
// than the column type. The engine's WF_SECTION_PRESS message carries
// componentName + sectionIndex only — no section_type — so this module
// derives it client-side until the engine carries the type explicitly.
//
// is_custom_section is decided by membership in KNOWN_TEMPLATES (engine
// blocks registered in components/ComponentRegistry.tsx). Anything not in
// the set is assumed custom-generated (per-client component under
// components/generated/<slug>/).
//
// Sync note: when a new template block lands on engine main, add it to
// KNOWN_TEMPLATES here. Falling behind isn't a correctness emergency —
// a missed template becomes is_custom_section=true (still a valid row,
// just mis-classified for the corpus dim).

// 61 blocks present on engine main (HEAD 2e954fb) under components/blocks/
// plus components/blocks/socialIcons.tsx (helper, not a section — excluded).
const KNOWN_TEMPLATES = new Set<string>([
  "AlertBannerTop",
  "ArticleGridSimple",
  "BeforeAndAfterSlider",
  "BentoGridAsymmetric",
  "BentoGridFeatures",
  "BentoHoverReveal",
  "ComparisonTableGlass",
  "ContactFormSplit",
  "CTAFloatingBottom",
  "CTAPulsingRing",
  "FAQAccordionMinimal",
  "FeatureAccordionSticky",
  "FeatureCardsHoverExpand",
  "FloatingDockNav",
  "FooterMegaColumns",
  "FooterNewsletterMinimal",
  "FooterRevealPerspective",
  "GalleryHorizontalScroll",
  "HeroCenteredLight",
  "HeroGeometricShapes",
  "HeroLocalService",
  "HeroSplitSlider",
  "HeroTextReveal",
  "HeroTypewriter",
  "HeroVideoGlass",
  "HeroVideoTextMask",
  "HoverImageRevealList",
  "InfiniteMarquee",
  "InteractiveStepTabs",
  "LogoCloud3D",
  "LogoGridStagger",
  "MagneticCTA",
  "MapSectionGlass",
  "NavbarMegaMenuGlass",
  "ParallaxMasonryGallery",
  "ParallaxTextMarquee",
  "PremiumContactFormGlass",
  "PricingCardsGlow",
  "PricingToggleSwitch",
  "ProcessTimelineGlowing",
  "ProseContentBlock",
  "ReviewBadgeSticky",
  "ScrollingImageFrames",
  "ServiceGridHoverDraw",
  "ServiceListClean",
  "SplitContentImage",
  "SplitHeroKinetic",
  "StatCounterGrid",
  "StatCounterRing",
  "StatsRowLight",
  "StepByStepCards",
  "StickyScrollProcess",
  "TeamCardsFlip",
  "TeamGridLight",
  "TestimonialCardsLight",
  "TestimonialCarouselDrag",
  "TestimonialVideoGrid",
  "TextMarqueeVertical",
  "VideoBackgroundGrid",
  "VideoModalPulse",
]);

export function isCustomSection(componentName: string): boolean {
  return !KNOWN_TEMPLATES.has(componentName);
}

// Maps componentName → section_type. Checks substring keywords in priority
// order. Order matters — "navbar" is checked before "hero" because no name
// contains both, but more specific names (footer-newsletter, video-modal)
// match the more specific concept first.
//
// Substring match (case-insensitive) — handles both:
//   - engine templates: "HeroLocalService"      → "hero"
//   - generated customs: "AandlTreeServiceHero1" → "hero" (the slug-prefix
//     contains "Service" but the suffix carries the role).
//
// Returns "other" for anything unmatched — satisfies NOT NULL, keeps the
// row in the corpus, and the lessons retriever can filter or bucket
// "other" however it wants later.
const TYPE_RULES: Array<[RegExp, string]> = [
  [/navbar/i, "navbar"],
  [/footer/i, "footer"],
  [/hero/i, "hero"],
  [/\bcta\b/i, "cta"], // matches "CTA" word boundary; also matches "MagneticCTA"
  [/magneticcta/i, "cta"],
  [/contact/i, "contact"],
  [/faq|accordion/i, "faq"],
  [/testimonial|review/i, "testimonials"],
  [/pricing/i, "pricing"],
  [/gallery|masonry|imageframes|hoverimage/i, "gallery"],
  [/logo/i, "logos"],
  [/stat|counter/i, "stats"],
  [/service/i, "services"],
  [/feature|bento/i, "features"],
  [/process|step|timeline|sticky/i, "process"],
  [/video|marquee|map|alert|dock|prose|comparison|interactive|beforeandafter|splithero|splitcontent/i, "media"],
];

export function deriveSectionType(componentName: string): string {
  for (const [re, type] of TYPE_RULES) {
    if (re.test(componentName)) return type;
  }
  return "other";
}
