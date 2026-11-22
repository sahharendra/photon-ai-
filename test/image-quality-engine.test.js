'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ASPECT_RATIO_PRESETS,
  MODEL_QUALITY_BENCHMARKS,
  analyzePrompt,
  enhancePrompt,
  selectOptimalImageModel,
  createTypographyOverlay,
  getModelQualityReport,
} = require('../image-quality-engine');

describe('PHOTON AI – Professional Image Quality, Photorealism & Prompt Accuracy Engine', () => {

  it('1: Correctly analyzes prompts and extracts subjects, counts, people, and lighting cues', () => {
    const prompt = 'Create a professional skincare advertisement with three products on a marble surface under studio softbox lighting.';
    const analysis = analyzePrompt(prompt);

    assert.equal(analysis.categories.isProduct, true);
    assert.equal(analysis.categories.isAd, true);
    assert.ok(analysis.counts.some(c => c.count === 'three' && c.object === 'products'));
    assert.ok(analysis.lightingCues.some(l => l.includes('studio')));
    assert.ok(analysis.envCues.some(e => e.includes('marble')));
  });

  it('2: Detects and maps social media aspect ratios and resolutions accurately (1:1, 4:5, 9:16, 16:9)', () => {
    // 4:5 Instagram Portrait
    const a45 = analyzePrompt('Create an Instagram 4:5 promotional advertisement for summer cosmetics.');
    assert.equal(a45.aspectRatio, '4:5');
    assert.equal(a45.dimensions.width, 896);
    assert.equal(a45.dimensions.height, 1120);

    // 9:16 Story / Reel / TikTok
    const a916 = analyzePrompt('9:16 vertical story video background for smartphone screen.');
    assert.equal(a916.aspectRatio, '9:16');
    assert.equal(a916.dimensions.width, 768);
    assert.equal(a916.dimensions.height, 1344);

    // 16:9 YouTube Thumbnail / Banner
    const a169 = analyzePrompt('16:9 landscape banner of a futuristic electric car on highway.');
    assert.equal(a169.aspectRatio, '16:9');
    assert.equal(a169.dimensions.width, 1344);
    assert.equal(a169.dimensions.height, 768);

    // 1:1 Square
    const a11 = analyzePrompt('A classic 1:1 square icon of a golden compass.');
    assert.equal(a11.aspectRatio, '1:1');
    assert.equal(a11.dimensions.width, 1024);
    assert.equal(a11.dimensions.height, 1024);
  });

  it('3: Extracts exact user-supplied text and prices without alteration or truncation', () => {
    const prompt = 'Create an Instagram 4:5 promotional advertisement with the exact text "GLOW NATURALLY" and "Special Offer $29.99"';
    const analysis = analyzePrompt(prompt);

    assert.ok(analysis.exactText.includes('GLOW NATURALLY'));
    assert.ok(analysis.exactText.includes('Special Offer $29.99'));
    assert.equal(analysis.categories.isTextHeavy, true);
  });

  it('4: Enhances portrait prompts with authentic skin texture, pores, and natural features without plastic smoothing', () => {
    const userPrompt = 'Generate a photorealistic portrait of a woman with natural skin texture.';
    const result = enhancePrompt(userPrompt);

    assert.equal(result.wasEnhanced, true);
    assert.equal(result.originalPrompt, userPrompt);

    const enhanced = result.enhancedPrompt;
    assert.ok(enhanced.includes(userPrompt), 'Original prompt must be preserved as base');
    assert.ok(enhanced.includes('unairbrushed skin texture'), 'Must include natural skin texture');
    assert.ok(enhanced.includes('visible fine pores'), 'Must include visible pores');
    assert.ok(enhanced.includes('corneal eye reflections'), 'Must include eye reflections');
    assert.ok(enhanced.includes('free from plastic skin'), 'Must actively avoid plastic smoothing');

    // Must NOT invent unrequested brands or people
    assert.equal(enhanced.includes('Nike'), false);
    assert.equal(enhanced.includes('Apple Inc'), false);
    assert.equal(/\bman\b/i.test(enhanced.replace(/\bwoman\b/gi, '')), false);
  });

  it('5: Enhances hands and anatomy with correct knuckle articulation and five distinct fingers', () => {
    const userPrompt = 'Create a realistic image of a woman holding a skincare product with both hands.';
    const result = enhancePrompt(userPrompt);

    assert.equal(result.analysis.categories.isHands, true);
    assert.equal(result.analysis.categories.isProduct, true);
    assert.ok(result.enhancedPrompt.includes('five distinct fingers per hand'));
    assert.ok(result.enhancedPrompt.includes('properly articulated finger joints'));
    assert.ok(result.enhancedPrompt.includes('knuckles and palms'));
  });

  it('6: Enhances product photography with studio lighting, packaging details, and physical reflections', () => {
    const userPrompt = 'Generate a realistic product photograph of a perfume bottle on a marble surface.';
    const result = enhancePrompt(userPrompt);

    assert.equal(result.analysis.categories.isProduct, true);
    assert.ok(result.enhancedPrompt.includes('commercial product photography'));
    assert.ok(result.enhancedPrompt.includes('studio softbox lighting'));
    assert.ok(result.enhancedPrompt.includes('clean polished marble surface'));
    assert.ok(result.enhancedPrompt.includes('micro-details on product packaging'));
  });

  it('7: Preserves unenhanced prompt when user requests enhance: false', () => {
    const userPrompt = 'A minimalist red cube on grey background.';
    const result = enhancePrompt(userPrompt, { enhance: false });

    assert.equal(result.wasEnhanced, false);
    assert.equal(result.enhancedPrompt, userPrompt);
    assert.equal(result.originalPrompt, userPrompt);
  });

  it('8: Selects optimal verified image model based on prompt demands', () => {
    const models = [
      { id: 'flux', name: 'FLUX.1 Schnell', provider: 'Pollinations AI', category: 'Image Generation', available: true },
      { id: 'sana', name: 'Sana Ultra-Fast', provider: 'Pollinations AI', category: 'Image Generation', available: true },
      { id: 'turbo', name: 'SDXL Turbo', provider: 'Pollinations AI', category: 'Image Generation', available: true },
    ];

    // Photorealistic portrait -> FLUX.1 Schnell
    const selPortrait = selectOptimalImageModel({
      prompt: 'Generate a photorealistic portrait of an elderly craftsman.',
      availableModels: models,
    });
    assert.equal(selPortrait.modelId, 'flux');

    // Text & advertisement -> FLUX.1 Schnell
    const selAd = selectOptimalImageModel({
      prompt: 'Create a poster with exact text "SUMMER SALE 50% OFF".',
      availableModels: models,
    });
    assert.equal(selAd.modelId, 'flux');

    // Respects explicit user model selection
    const selExplicit = selectOptimalImageModel({
      prompt: 'Quick concept sketch of a sports car.',
      requestedModel: 'sana',
      availableModels: models,
    });
    assert.equal(selExplicit.modelId, 'sana');
  });

  it('9: Model Quality Evaluation Report exposes transparent benchmarks across the 7 required categories', () => {
    const report = getModelQualityReport();

    assert.ok(report.benchmarks);
    assert.ok(report.benchmarks['flux']);
    assert.equal(report.benchmarks['flux'].photorealism, 96);
    assert.equal(report.benchmarks['flux'].anatomyAndHands, 93);
    assert.equal(report.benchmarks['flux'].productPhotography, 96);
    assert.equal(report.benchmarks['flux'].textRendering, 92);

    assert.ok(Array.isArray(report.evaluationCategories));
    assert.ok(report.evaluationCategories.includes('Photorealism'));
    assert.ok(report.evaluationCategories.includes('Human Anatomy & Hands'));
    assert.ok(report.evaluationCategories.includes('Product Photography'));
    assert.ok(report.evaluationCategories.includes('Text & Typography Rendering'));
  });

  it('10: Verifies all 6 required Acceptance Prompts from Section 12', () => {
    // 1. "Generate a photorealistic portrait of a woman with natural skin texture."
    const p1 = enhancePrompt('Generate a photorealistic portrait of a woman with natural skin texture.');
    assert.ok(p1.enhancedPrompt.includes('unairbrushed skin texture'));
    assert.ok(p1.enhancedPrompt.includes('visible fine pores'));

    // 2. "Create a professional skincare advertisement with three products and readable promotional text."
    const p2 = enhancePrompt('Create a professional skincare advertisement with three products and readable promotional text.');
    assert.equal(p2.analysis.categories.isAd, true);
    assert.equal(p2.analysis.categories.isProduct, true);
    assert.ok(p2.analysis.counts.some(c => c.count === 'three'));
    assert.ok(p2.enhancedPrompt.includes('professional advertising layout'));

    // 3. "Generate a realistic product photograph of a perfume bottle on a marble surface."
    const p3 = enhancePrompt('Generate a realistic product photograph of a perfume bottle on a marble surface.');
    assert.equal(p3.analysis.categories.isProduct, true);
    assert.ok(p3.enhancedPrompt.includes('clean polished marble surface'));

    // 4. "Create a realistic image of a woman holding a skincare product with both hands."
    const p4 = enhancePrompt('Create a realistic image of a woman holding a skincare product with both hands.');
    assert.equal(p4.analysis.categories.isHands, true);
    assert.ok(p4.enhancedPrompt.includes('five distinct fingers per hand'));

    // 5. "Follow my uploaded reference image and change only the background."
    const p5 = analyzePrompt('Follow my uploaded reference image and change only the background.');
    assert.equal(p5.categories.isImg2Img, true);

    // 6. "Create an Instagram 4:5 promotional advertisement with the exact text I supplied."
    const p6 = enhancePrompt('Create an Instagram 4:5 promotional advertisement with the exact text "SUMMER GLOW"');
    assert.equal(p6.aspectRatio, '4:5');
    assert.equal(p6.dimensions.width, 896);
    assert.equal(p6.dimensions.height, 1120);
    assert.ok(p6.analysis.exactText.includes('SUMMER GLOW'));
  });

  it('11: Typography overlay produces crisp SVG vector overlay with proper scaling and contrast', () => {
    const overlay = createTypographyOverlay({
      text: 'SPECIAL OFFER: $49',
      width: 1024,
      height: 1024,
    });

    assert.ok(overlay);
    assert.ok(overlay.dataUrl.startsWith('data:image/svg+xml;base64,'));
    assert.ok(overlay.svg.includes('SPECIAL OFFER: $49'));
    assert.ok(overlay.fontSize >= 24);
  });
});
