const puppeteer = require('puppeteer');
const fs = require('.fs');
const path = require('path');

// Add to the top of scraper.js
const browserPool = [];
const MAX_BROWSERS = 3;

async function getOrCreateBrowser() {
  if (browserPool.length > 0) {
    return browserPool.pop();
  }
  
  return await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      // ...existing args
    ]
  });
}

// At the top of your scraper.js
const scrapingQueue = [];
let isProcessing = false;
const RATE_LIMIT_DELAY = 200; // 2 seconds between requests

const productCache = new Map();
const CACHE_TTL = 3600000; // 1 hour in milliseconds

async function processQueue() {
  if (isProcessing || scrapingQueue.length === 0) return;
  
  isProcessing = true;
  const { url, resolve, reject } = scrapingQueue.shift();
  
  console.log(`Processing queue item: ${url}`);
  
  try {
    const result = await actualScrapeFunction(url);
    resolve(result);
  } catch (error) {
    console.error('Error in processQueue:', error);
    reject(error);
  } finally {
    isProcessing = false;
    
    // Continue processing queue after a delay
    if (scrapingQueue.length > 0) {
      console.log(`Queue has ${scrapingQueue.length} remaining items. Processing next after delay.`);
      setTimeout(processQueue, RATE_LIMIT_DELAY);
    } else {
      console.log('Queue processing complete.');
    }
  }
}

// Create a browser instance once
let browser;

async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    });
  }
  return browser;
}

let browserPagePool = [];
const MAX_PAGES = 10;

async function getPage() {
  if (browserPagePool.length > 0) {
    return browserPagePool.pop();
  }
  
  const browser = await initBrowser();
  const page = await browser.newPage();
  
  // Set viewport and user agent
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  
  // Set request interception
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const url = request.url().toLowerCase();
    
    // Block more resource types and specific domains
    if (resourceType === 'image' || 
        resourceType === 'font' || 
        resourceType === 'media' || 
        resourceType === 'stylesheet' ||
        url.includes('google-analytics') ||
        url.includes('facebook') ||
        url.includes('analytics') ||
        url.includes('tracker') ||
        url.includes('advertisement')) {
      request.abort();
    } else {
      request.continue();
    }
  });
  
  return page;
}

function releasePage(page) {
  if (browserPagePool.length < MAX_PAGES) {
    browserPagePool.push(page);
  } else {
    page.close().catch(console.error);
  }
}

// Add to your scraper.js
function saveToFileCache(productId, data) {
  const cacheDir = path.join(__dirname, 'cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }
  
  // Save individual product cache
  fs.writeFileSync(
    path.join(cacheDir, `${productId}.json`), 
    JSON.stringify({timestamp: Date.now(), data})
  );
  
  // Regenerate the combined JSON after adding a new product
  generateCombinedProductsJSON();
}

// Add this function to generate a combined products JSON file

function generateCombinedProductsJSON() {
  const cacheDir = path.join(__dirname, 'cache');
  const combinedPath = path.join(__dirname, 'products.json');
  const allProducts = {};
  
  // Check if cache directory exists
  if (!fs.existsSync(cacheDir)) {
    console.log('Cache directory does not exist, creating it.');
    fs.mkdirSync(cacheDir);
    return; // No files to process
  }
  
  try {
    // Read all JSON files in the cache directory
    const files = fs.readdirSync(cacheDir).filter(file => file.endsWith('.json'));
    
    if (files.length === 0) {
      console.log('No product cache files found.');
      return;
    }
    
    console.log(`Found ${files.length} product files in cache.`);
    
    // Process each file and build the combined data
    for (const file of files) {
      try {
        const filePath = path.join(cacheDir, file);
        const rawData = fs.readFileSync(filePath, 'utf8');
        const productData = JSON.parse(rawData);
        
        // Extract product ID from filename (remove .json extension)
        const productId = path.basename(file, '.json');
        
        // Add to the combined object
        allProducts[productId] = {
          lastUpdated: productData.timestamp,
          ...productData.data.data
        };
      } catch (err) {
        console.error(`Error processing file ${file}:`, err);
      }
    }
    
    // Save the combined data
    fs.writeFileSync(
      combinedPath, 
      JSON.stringify({
        lastGenerated: Date.now(),
        productCount: Object.keys(allProducts).length,
        products: allProducts
      }, null, 2) // Add indentation for readability
    );
    
    console.log(`Successfully generated combined products JSON with ${Object.keys(allProducts).length} products.`);
    return combinedPath;
  } catch (err) {
    console.error('Error generating combined products JSON:', err);
  }
}

// Add an endpoint to manually regenerate the combined JSON
// This can be called via API rather than regenerating on every save
async function regenerateCombinedJSON() {
  return generateCombinedProductsJSON();
}

// Update the actualScrapeFunction in scraper.js to handle errors more gracefully
function actualScrapeFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    try {
      // URL validation - more flexible to allow internal testing with IDs
      if (!url || !(url.includes('myntra.com') || /^\d+$/.test(url))) {
        throw new Error('Invalid Myntra URL or product ID');
      }

      console.log(`Attempting to scrape: ${url}`);
      
      page = await getPage();
      
      // Increase timeout and modify navigation settings
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', // Changed from networkidle2 to make it faster
        timeout: 45000  // Increased from 30000 to 45000
      });

      // Try a more robust approach to wait for content
      try {
        await Promise.race([
          page.waitForSelector('h1, .pdp-name, .pdp-title, .product-title, div[class*="price"]', { timeout: 20000 }),
          page.waitForFunction(() => document.title && document.title !== 'Loading...', { timeout: 20000 }),
          // Wait at least 5 seconds for basic content
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
      } catch (waitError) {
        console.log('Wait for selector timed out, but continuing anyway');
      }

      // Add this near the top of the file with other configuration constants
      const SAVE_DEBUG_SCREENSHOTS = false; // Set to true when debugging is needed

      // Then modify the screenshot code in actualScrapeFunction (around line 200)
      // Replace these lines:
      // Take a screenshot for debugging purposes
      // const screenshotPath = `debug-${url.split('/').pop()}-${Date.now()}.png`;
      // await page.screenshot({ path: screenshotPath });

      // With this conditional code:
      if (SAVE_DEBUG_SCREENSHOTS) {
        const screenshotPath = `debug-${url.split('/').pop()}-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath });
        console.log(`Debug screenshot saved: ${screenshotPath}`);
      }

      // Try to expand any collapsed sections
      await page.evaluate(() => {
        const clickTargets = [
          'button.more-details',
          'button.show-more',
          '.expand-button',
          '.view-details'
        ];
        
        for (const selector of clickTargets) {
          const elements = document.querySelectorAll(selector);
          if (elements && elements.length > 0) {
            try {
              elements[0].click();
              console.log("Clicked on:", selector);
            } catch (e) {
              // Click failed, just continue
            }
          }
        }
      });

      // Wait a moment for any updates triggered by the clicks
      await page.waitForTimeout(1000);
      
      // Wait for the main content to load
      await page.waitForSelector('h1, .pdp-name, .pdp-title, .product-title, div[class*="price"]', 
        { timeout: 10000 })
        .catch(() => console.log('Could not find standard product selectors, continuing anyway'));

      // Scroll down to ensure all dynamic content loads
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });

      // Wait a moment for any lazy-loaded content
      await page.waitForTimeout(1000);

      // Now extract the product data with our enhanced selector logic
      const productData = await page.evaluate(() => {
        const data = {
          title: document.title.replace(' | Myntra', '') || "Unknown Product",
          brand: "Unknown Brand",
          price: "N/A",
          description: "",
          images: [],
          availability: "unknown" 
        };
        
        try {
          // Extract title (multiple approaches)
          const titleSelectors = [
            '.pdp-title h1', 
            '.pdp-name', 
            '.title-container h1',
            'h1.title',
            'h1'
          ];
          
          for (const selector of titleSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              data.title = element.textContent.trim();
              break;
            }
          }
          
          // Extract brand (multiple approaches)
          const brandSelectors = [
            '.pdp-title .brand-name', 
            '.brand-name',
            '.pdp-product-brand',
            'h1.title + div',
            '.breadcrumbs a:first-child'
          ];
          
          for (const selector of brandSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              data.brand = element.textContent.trim();
              break;
            }
          }
          
          // Extract price (more precise approaches)
          const priceSelectors = [
            '.pdp-price .selling-price strong',
            '.pdp-price strong',
            '.pdp-price .selling-price',
            'span.pdp-price strong',
            'div.price-disconnect-container span.strike',
            'div.price-disconnect-container span',
            'p.price-container span',
            '.pdp-mrp s',
            '.pdp-price .discount-container',
            'span[class*="discountedPrice"]',
            '.price-value',
            'div[class*="priceWrapper"] span',
            'span[class*="lfloat product-price"]',
            'div[class*="PriceSection"]',
            'span[class*="price"]'
          ];
          
          for (const selector of priceSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              // Extract only the numbers from price text
              let priceText = element.textContent.trim();
              
              // Check if this is really a price (should contain ₹ or Rs. or similar)
              if (!/[₹₨Rs.]/i.test(priceText) && !/price/i.test(element.parentElement?.className || '')) {
                continue; // Skip this element if it doesn't look like a price
              }
              
              // Extract numbers, handling Indian style pricing (₹1,999)
              let priceMatch = priceText.match(/[₹₨Rs.]*\s*([,\d]+)/i);
              if (priceMatch && priceMatch[1]) {
                // Verify this is likely a price and not a product ID by checking its length
                // Product IDs are typically 8 digits, prices usually less
                const cleanPrice = priceMatch[1].replace(/,/g, '');
                if (cleanPrice.length <= 6) { // Most prices are under 1,000,000
                  data.price = cleanPrice;
                  break;
                }
              }
            }
          }
          
          // If still no price, try a last resort HTML content search
          if (data.price === "N/A") {
            // Add debug output
            console.log("Using last resort price extraction");
            
            // Try to identify price sections more intelligently
            const potentialPriceContainers = document.querySelectorAll('div[class*="price"], span[class*="price"], p[class*="price"]');
            for (const container of potentialPriceContainers) {
              const text = container.textContent.trim();
              // Only consider texts that have currency symbols and don't look like product IDs
              if ((/[₹₨Rs.]/i.test(text) || /^\s*\d{2,4}\s*$/.test(text)) && !/^\d{8,}$/.test(text)) {
                const matches = text.match(/[\d,]+/g);
                if (matches && matches.length > 0) {
                  // Get the first number that seems like a reasonable price (not too long)
                  for (const match of matches) {
                    const cleanPrice = match.replace(/,/g, '');
                    if (cleanPrice.length <= 6) {
                      data.price = cleanPrice;
                      break;
                    }
                  }
                  if (data.price !== "N/A") break;
                }
              }
            }
          }
          
          // Add debugging output
          if (data.price === "N/A") {
            // Log all potential numeric content for debugging
            const allNumericTexts = [];
            document.querySelectorAll('*').forEach(el => {
              if (el.textContent && /\d/.test(el.textContent) && el.textContent.trim().length < 20) {
                const text = el.textContent.trim();
                allNumericTexts.push({
                  text: text,
                  tag: el.tagName,
                  class: el.className
                });
              }
            });
            
            // Try extracting from structured data as a last resort
            const structuredDataElements = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of structuredDataElements) {
              try {
                const jsonData = JSON.parse(script.textContent);
                if (jsonData.offers && jsonData.offers.price) {
                  data.price = jsonData.offers.price.toString();
                  break;
                } else if (jsonData.price) {
                  data.price = jsonData.price.toString();
                  break;
                }
              } catch (e) {
                // JSON parsing failed, continue
              }
            }
          }
          
          // Extract product description
          const descriptionSelectors = [
            '.pdp-product-description',
            '.description',
            'div[class*="description"]'
          ];
          
          for (const selector of descriptionSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              data.description = element.textContent.trim();
              break;
            }
          }
          
          // Try to extract structured data if available (often has complete product info)
          const structuredDataElements = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of structuredDataElements) {
            try {
              const jsonData = JSON.parse(script.textContent);
              
              // Product schema
              if (jsonData['@type'] === 'Product') {
                if (!data.title || data.title === "Unknown Product") data.title = jsonData.name;
                
                if (!data.brand || data.brand === "Unknown Brand") {
                  if (jsonData.brand && jsonData.brand.name) {
                    data.brand = jsonData.brand.name;
                  } else if (typeof jsonData.brand === "string") {
                    data.brand = jsonData.brand;
                  }
                }
                
                if (!data.description) data.description = jsonData.description;
                
                if (data.price === "N/A" && jsonData.offers && jsonData.offers.price) {
                  data.price = jsonData.offers.price;
                }
                
                if (jsonData.image) {
                  data.images = Array.isArray(jsonData.image) ? jsonData.image : [jsonData.image];
                }
              }
            } catch (e) {
              // JSON parsing failed, continue
            }
          }
          
          // Try a last-resort approach to extract info from the page title
          if (data.title === "Unknown Product" || data.brand === "Unknown Brand") {
            const pageTitle = document.title;
            const titleParts = pageTitle.split(' - ')[0].split(' ');
            
            if (titleParts.length > 1 && data.brand === "Unknown Brand") {
              data.brand = titleParts[0];
            }
            
            if (data.title === "Unknown Product") {
              data.title = pageTitle.replace(' | Myntra', '');
            }
          }
          
          // Check product availability
          function checkAvailability() {
            try {
              // FIRST CHECK: Look for the ADD TO BAG div element pattern specific to Myntra
              // This is the most reliable indicator a product is in stock
              const addToBagElements = document.querySelectorAll('.pdp-add-to-bag:not(.pdp-out-of-stock)');
              if (addToBagElements && addToBagElements.length > 0) {
                console.log("Found ADD TO BAG element - product is in stock");
                return 'in_stock';
              }
              
              // SECOND CHECK: Check for specific out-of-stock indicators used by Myntra
              const outOfStockElements = document.querySelectorAll('.size-buttons-out-of-stock, .pdp-out-of-stock, .soldOutP');
              if (outOfStockElements && outOfStockElements.length > 0) {
                console.log("Found out of stock indicator elements");
                return 'out_of_stock';
              }
              
              // THIRD CHECK: Check text content for "out of stock" phrases
              // Use parentElement check to target only text directly in these elements
              const stockStatusElements = document.querySelectorAll('.pdp-add-to-bag, .pdp-action-container, .size-buttons-container');
              for (const element of stockStatusElements) {
                if (element.textContent.toLowerCase().includes('out of stock') || 
                    element.textContent.toLowerCase().includes('sold out')) {
                  console.log("Found 'out of stock' text in relevant element");
                  return 'out_of_stock';
                }
              }
              
              // FOURTH CHECK: Check if all size buttons are marked as out of stock
              const sizeElements = document.querySelectorAll('.size-buttons-unified-size');
              if (sizeElements && sizeElements.length > 0) {
                const allSizesOutOfStock = Array.from(sizeElements).every(el => 
                  el.classList.contains('size-buttons-unified-size-out-of-stock') || 
                  el.classList.contains('size-buttons-unified-size-strike-hide')
                );
                
                if (allSizesOutOfStock) {
                  console.log("All size buttons are marked as out of stock");
                  return 'out_of_stock';
                } else {
                  console.log("Found available sizes - product is in stock");
                  return 'in_stock';
                }
              }
              
              // FIFTH CHECK: Final check for any ADD TO BAG text in relevant containers
              const anyBagText = document.body.textContent.includes('ADD TO BAG');
              if (anyBagText && !document.body.textContent.includes('OUT OF STOCK')) {
                console.log("Found ADD TO BAG text without OUT OF STOCK text");
                return 'in_stock';
              }
              
              // Default to in_stock for Myntra (as they typically don't show unavailable products)
              console.log("No definitive indicators found, defaulting to in_stock");
              return 'in_stock';
            } catch (e) {
              console.error('Error checking availability:', e);
              return 'in_stock'; // Default to in_stock on error
            }
          }

          // Add this to the initial data object
          data.availability = checkAvailability();

          // Also check if any sizes are available (Myntra often has size selectors)
          try {
            const sizeElements = document.querySelectorAll('.size-buttons-unified-size');
            const availableSizes = Array.from(sizeElements)
              .filter(el => !el.classList.contains('size-buttons-unified-size-out-of-stock') && 
                          !el.classList.contains('size-buttons-unified-size-strike-hide'))
              .map(el => el.textContent.trim());
            
            if (availableSizes.length > 0) {
              data.availableSizes = availableSizes;
              data.availability = 'in_stock';
            } else if (sizeElements.length > 0) {
              // If there are size elements but none are available
              data.availableSizes = [];
              data.availability = 'out_of_stock';
            }
          } catch (e) {
            console.error('Error extracting size availability:', e);
          }
          
          // Try to extract multiple product images
          try {
            // First look for Myntra's image carousel
            const imageContainers = document.querySelectorAll('.image-grid-imageContainer, .image-grid-container img, .image-grid-image');
            if (imageContainers && imageContainers.length > 0) {
              data.images = Array.from(imageContainers)
                .map(img => {
                  // Try multiple ways to get the image URL
                  const src = img.src || img.getAttribute('src') || 
                             img.style.backgroundImage?.replace(/^url\(['"](.+)['"]\)$/, '$1') ||
                             img.getAttribute('data-src');
                  return src;
                })
                .filter(url => url && url.includes('myntassets.com')); // Only keep valid Myntra URLs
            }
            
            // If no images found, look for product schema images
            if (!data.images || data.images.length === 0) {
              const schemaImages = document.querySelector('script[type="application/ld+json"]');
              if (schemaImages) {
                try {
                  const jsonData = JSON.parse(schemaImages.textContent);
                  if (jsonData.image) {
                    data.images = Array.isArray(jsonData.image) ? jsonData.image : [jsonData.image];
                  }
                } catch (e) {
                  console.error('Error parsing image JSON', e);
                }
              }
            }
            
            // Last resort - get any images with product IDs in the URL
            if (!data.images || data.images.length === 0) {
              const allImages = document.querySelectorAll('img');
              data.images = Array.from(allImages)
                .map(img => img.src || img.getAttribute('src'))
                .filter(url => url && url.includes('myntassets.com'));
            }
          } catch (e) {
            console.error('Error extracting product images:', e);
          }
          
        } catch (e) {
          console.error('Error extracting product data:', e);
        }
        
        return data;
      });
      
      // We won't throw an error if title is missing, just use default
      console.log('Successfully scraped product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Myntra:', error.message);
      
      // Return an error response instead of rejecting
      resolve({
        success: false,
        error: 'Failed to scrape product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Replace your existing checkAvailability function with this improved version

function checkAvailability() {
  try {
    // FIRST CHECK: Look for the ADD TO BAG div element pattern specific to Myntra
    // This is the most reliable indicator a product is in stock
    const addToBagElements = document.querySelectorAll('.pdp-add-to-bag:not(.pdp-out-of-stock)');
    if (addToBagElements && addToBagElements.length > 0) {
      console.log("Found ADD TO BAG element - product is in stock");
      return 'in_stock';
    }
    
    // SECOND CHECK: Check for specific out-of-stock indicators used by Myntra
    const outOfStockElements = document.querySelectorAll('.size-buttons-out-of-stock, .pdp-out-of-stock, .soldOutP');
    if (outOfStockElements && outOfStockElements.length > 0) {
      console.log("Found out of stock indicator elements");
      return 'out_of_stock';
    }
    
    // THIRD CHECK: Check text content for "out of stock" phrases
    // Use parentElement check to target only text directly in these elements
    const stockStatusElements = document.querySelectorAll('.pdp-add-to-bag, .pdp-action-container, .size-buttons-container');
    for (const element of stockStatusElements) {
      if (element.textContent.toLowerCase().includes('out of stock') || 
          element.textContent.toLowerCase().includes('sold out')) {
        console.log("Found 'out of stock' text in relevant element");
        return 'out_of_stock';
      }
    }
    
    // FOURTH CHECK: Check if all size buttons are marked as out of stock
    const sizeElements = document.querySelectorAll('.size-buttons-unified-size');
    if (sizeElements && sizeElements.length > 0) {
      const allSizesOutOfStock = Array.from(sizeElements).every(el => 
        el.classList.contains('size-buttons-unified-size-out-of-stock') || 
        el.classList.contains('size-buttons-unified-size-strike-hide')
      );
      
      if (allSizesOutOfStock) {
        console.log("All size buttons are marked as out of stock");
        return 'out_of_stock';
      } else {
        console.log("Found available sizes - product is in stock");
        return 'in_stock';
      }
    }
    
    // FIFTH CHECK: Final check for any ADD TO BAG text in relevant containers
    const anyBagText = document.body.textContent.includes('ADD TO BAG');
    if (anyBagText && !document.body.textContent.includes('OUT OF STOCK')) {
      console.log("Found ADD TO BAG text without OUT OF STOCK text");
      return 'in_stock';
    }
    
    // Default to in_stock for Myntra (as they typically don't show unavailable products)
    console.log("No definitive indicators found, defaulting to in_stock");
    return 'in_stock';
  } catch (e) {
    console.error('Error checking availability:', e);
    return 'in_stock'; // Default to in_stock on error
  }
}

// Update the scrapeMyntraProduct function in scraper.js
async function scrapeMyntraProduct(url) {
  // Check if the input is just an ID number
  if (/^\d+$/.test(url)) {
    // Convert numeric ID to a proper Myntra URL format
    // Try both formats since we don't know which is correct
    console.log(`Received numeric ID: ${url}, converting to URL`);
    
    // For format /product-name/brand/product-id
    url = `https://www.myntra.com/products/${url}`;
  } else if (!url.startsWith('http')) {
    // If URL doesn't start with http, assume it's a path and prepend Myntra domain
    url = `https://www.myntra.com/${url}`;
  }
  
  console.log(`Final URL being processed: ${url}`);
  
  // Extract product ID from URL (last segment)
  const urlSegments = url.split('/');
  const productId = urlSegments[urlSegments.length - 1];
  
  // Check if in cache and not expired
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // If not in cache or expired, scrape and then cache
  return new Promise((resolve, reject) => {
    actualScrapeFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Add Amazon scraping implementation
async function scrapeAmazonProduct(url) {
  console.log(`Scraping Amazon product: ${url}`);
  
  // Extract ASIN from URL if needed
  let productId = 'unknown';
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
  if (asinMatch) {
    productId = asinMatch[1];
  }
  
  // Check cache like the Myntra implementation
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for Amazon product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // Similar pattern to scrapeMyntraProduct
  return new Promise((resolve, reject) => {
    actualScrapeAmazonFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Amazon scraping implementation
function actualScrapeAmazonFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    
    try {
      page = await getPage();
      
      // Set user agent to avoid bot detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      console.log(`Navigating to Amazon URL: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      if (!response || response.status() !== 200) {
        throw new Error(`Failed to load Amazon page: ${response ? response.status() : 'No response'}`);
      }
      
      // Check for CAPTCHA page
      const pageTitle = await page.title();
      if (pageTitle.includes('Robot') || pageTitle.includes('CAPTCHA')) {
        throw new Error('Amazon bot protection detected. Please try again later.');
      }
      
      // Extract product data
      const productData = await page.evaluate(() => {
        const data = {
          title: document.querySelector('#productTitle')?.textContent.trim() || 'Unknown Product',
          brand: document.querySelector('#bylineInfo')?.textContent.trim() || 'Unknown Brand',
          price: document.querySelector('.a-price .a-offscreen')?.textContent.trim() || 'N/A',
          description: document.querySelector('#productDescription')?.textContent.trim() || 
                       document.querySelector('#feature-bullets')?.textContent.trim() || '',
          images: [],
          availableSizes: []
        };
        
        // Get all image URLs
        const imageElements = document.querySelectorAll('#altImages img');
        if (imageElements && imageElements.length > 0) {
          data.images = Array.from(imageElements)
            .map(img => {
              const src = img.dataset.oldHires || img.src;
              return src.replace(/._[^.]+\./, '.'); // Convert to full-size image
            })
            .filter(url => url && !url.includes('spinner') && !url.includes('play-button'));
        }
        
        // Get main image if altImages is empty
        if (data.images.length === 0) {
          const mainImage = document.querySelector('#landingImage, #imgBlkFront');
          if (mainImage) {
            const src = mainImage.dataset.oldHires || mainImage.src;
            data.images.push(src);
          }
        }
        
        // Check availability
        const availabilityText = document.querySelector('#availability')?.textContent.trim() || '';
        data.availability = availabilityText.toLowerCase().includes('in stock') ? 'in_stock' : 'out_of_stock';
        
        // Extract sizes if available (for clothing items)
        const sizeElements = document.querySelectorAll('#variation_size_name .a-size-base:not(.a-color-secondary)');
        if (sizeElements && sizeElements.length > 0) {
          data.availableSizes = Array.from(sizeElements)
            .map(el => el.textContent.trim())
            .filter(size => size);
        }
        
        return data;
      });
      
      console.log('Successfully scraped Amazon product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Amazon:', error.message);
      
      resolve({
        success: false,
        error: 'Failed to scrape Amazon product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Add Flipkart scraping implementation
async function scrapeFlipkartProduct(url) {
  console.log(`Scraping Flipkart product: ${url}`);
  
  // Extract product ID from URL
  let productId = 'unknown';
  const pidMatch = url.match(/pid=([^&]+)/);
  if (pidMatch) {
    productId = pidMatch[1];
  } else {
    // Alternative pattern
    const altMatch = url.match(/\/p\/([^/]+)/);
    if (altMatch) {
      productId = altMatch[1];
    }
  }
  
  // Check cache like the Myntra implementation
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for Flipkart product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // Similar pattern to scrapeMyntraProduct
  return new Promise((resolve, reject) => {
    actualScrapeFlipkartFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Flipkart scraping implementation
function actualScrapeFlipkartFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    
    try {
      page = await getPage();
      
      console.log(`Navigating to Flipkart URL: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      if (!response || response.status() !== 200) {
        throw new Error(`Failed to load Flipkart page: ${response ? response.status() : 'No response'}`);
      }
      
      // Extract product data
      const productData = await page.evaluate(() => {
        const data = {
          title: document.querySelector('h1.yhB1nd')?.textContent.trim() || 
                 document.querySelector('h1.B_NuCI')?.textContent.trim() || 'Unknown Product',
          brand: document.querySelector('span.G6XhRU')?.textContent.trim() || 'Unknown Brand',
          price: document.querySelector('._30jeq3')?.textContent.trim() || 'N/A',
          description: document.querySelector('._1mXcCf')?.textContent.trim() || '',
          images: [],
          availableSizes: []
        };
        
        // Get all image URLs
        const imageElements = document.querySelectorAll('._2amPTt img, .CXW8mj img, ._3nMexc img');
        if (imageElements && imageElements.length > 0) {
          data.images = Array.from(imageElements)
            .map(img => img.src)
            .filter(url => url && url.includes('flipkart') && !url.includes('placeholder'));
        }
        
        // Check availability
        const outOfStock = document.querySelector('._16FRp0');
        data.availability = outOfStock ? 'out_of_stock' : 'in_stock';
        
        // Extract sizes if available (for clothing items)
        const sizeElements = document.querySelectorAll('._1fGeJ5._2UVyXR._31hAvz');
        if (sizeElements && sizeElements.length > 0) {
          data.availableSizes = Array.from(sizeElements)
            .map(el => el.textContent.trim())
            .filter(size => size);
        }
        
        return data;
      });
      
      console.log('Successfully scraped Flipkart product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Flipkart:', error.message);
      
      resolve({
        success: false,
        error: 'Failed to scrape Flipkart product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Update the exports
module.exports = {
  scrapeMyntraProduct,
  scrapeAmazonProduct,
  scrapeFlipkartProduct,
  regenerateCombinedJSON
};