/**
 * Google Maps Editor Widget for Optimizely CMS
 * 
 * A custom property editor that allows users to select and manage geographic coordinates
 * using Google Maps and the Places API.
 * 
 * Features:
 * - Interactive Google Maps display with marker placement
 * - Place autocomplete search with custom suggestions dropdown
 * - Right-click on map to set coordinates
 * - Support for both object (latitude/longitude) and string (lat,lng) coordinate formats
 * - Session token optimization for Places API calls
 * - Full cleanup on widget destruction
 * 
 * Dependencies:
 * - Google Maps JavaScript API v=weekly with places library
 * - Dojo framework (dijit, dojo/on, dojo/keys, etc.)
 * - Optimizely CMS (epi/shell/widget/dialog/LightWeight)
 */
define([
    "dojo/on",
    "dojo/_base/declare", // Used to declare the actual widget
    "dojo/keys",
    "dojo/dom-construct",
    "dojo/dom-class",
    "dojo/dom-style",

    "dijit/_TemplatedMixin", // Widgets will be based on an external template (string literal, external file, or URL request)
    "dijit/_WidgetsInTemplateMixin", // The widget will in itself contain additional widgets
    "dijit/form/_FormValueWidget", // Widget is used to modify a form value (i.e. content property value)

    "epi/shell/widget/dialog/LightWeight", // Used to display the help message

    "dojo/i18n!./nls/Labels", // Localization files containing translations
    "dojo/text!./WidgetTemplate.html",
    'xstyle/css!./WidgetTemplate.css' // CSS to load when widget is loaded
],
function (
    on,
    declare,
    keys,
    domConstruct,
    domClass,
    domStyle,
    _TemplatedMixin,
    _WidgetsInTemplateMixin,
    _FormValueWidget,
    LightWeight,
    Labels,
    template
) {
    return declare([_FormValueWidget, _TemplatedMixin, _WidgetsInTemplateMixin], {

        // ==================== Configuration Properties ====================
        
        /**
         * Google Maps API key
         * @type {string}
         */
        apiKey: null,

        /**
         * Google Maps style ID for custom map styling
         * @type {string}
         */
        mapId: null,

        /**
         * Default zoom level when map initializes (1-20)
         * @type {number}
         */
        defaultZoom: null,

        /**
         * Default center coordinates for initial map view
         * @type {{latitude: number, longitude: number}}
         */
        defaultCoordinates: null,

        // ==================== Instance Properties ====================

        /**
         * Cached Places library exports (AutocompleteSessionToken, AutocompleteSuggestion)
         * @type {Object}
         * @private
         */
        _placesLibrary: null,

        /**
         * Google Maps instance
         * @type {google.maps.Map}
         * @private
         */
        _map: null,

        /**
         * Map marker instance (AdvancedMarkerElement)
         * @type {google.maps.marker.AdvancedMarkerElement}
         * @private
         */
        _marker: null,

        /**
         * Session token for Places API autocomplete requests
         * Reused across multiple requests in same session, reset after place selection
         * @type {google.maps.places.AutocompleteSessionToken}
         * @private
         */
        _sessionToken: null,

        /**
         * Array of autocomplete suggestions from last search
         * @type {Array}
         * @private
         */
        _suggestions: null,

        /**
         * DOM element for suggestions dropdown list
         * @type {HTMLUListElement}
         * @private
         */
        _suggestionsDropdown: null,

        /**
         * Index of currently highlighted suggestion (-1 = none)
         * @type {number}
         * @private
         */
        _selectedSuggestionIndex: -1,

        /**
         * Timer ID for debounced autocomplete search
         * @type {number}
         * @private
         */
        _typingTimer: null,

        /**
         * Localized labels and messages
         * @type {Object}
         * @private
         */
        _localized: Labels,

        /**
         * Help dialog instance
         * @type {epi/shell/widget/dialog/LightWeight}
         * @private
         */
        _helpDialog: null,

        /**
         * Prefix for console log messages
         * @type {string}
         * @private
         */
        _logPrefix: "[GoogleMapsEditor]",

        /**
         * HTML template string
         * @type {string}
         */
        templateString: template,

        // ==================== Public Methods ====================

        /**
         * Sets the widget value and refreshes marker location on map.
         * Handles both object format {latitude, longitude} and string format "lat,lng"
         * @param {*} newValue - The new coordinate value
         * @param {boolean} [priorityChange] - Priority change flag (Dojo)
         */
        _setValueAttr: function (newValue, priorityChange) {
            this.inherited(arguments);
            this.textbox.value = newValue || "";

            if (this._marker == null) {
                this._refreshMarkerLocation();
            }

            if (this._isComplexType()) {
                this.onChange(newValue);
            }
        },

        /**
         * Validates the property value (invoked by Optimizely)
         * Required properties must have valid coordinates
         * @returns {boolean} True if valid, false otherwise
         */
        isValid: function () {
            if (this.required) {
                return this._hasCoordinates();
            }
            return true;
        },

        /**
         * Determines if the property is complex type (object with latitude/longitude)
         * vs simple string type (comma-separated coordinates)
         * @param {*} [value] - Optional value to check (uses this.value if not provided)
         * @returns {boolean} True if complex type, false if simple string type
         */
        _isComplexType: function (value) {
            let valueToCheck = value || this.value;

            if (valueToCheck && typeof valueToCheck === "object") {
                return true;
            }

            if (Array.isArray(this.properties)) {
                return this.properties.length > 0;
            }

            if (this.metadata && Array.isArray(this.metadata.properties)) {
                return this.metadata.properties.length > 0;
            }

            return false;
        },

        /**
         * Checks if current value has valid coordinates
         * @returns {boolean} True if coordinates are valid and non-zero
         */
        _hasCoordinates: function () {
            if (!this.value) return false;

            if (this._isComplexType()) {
                return typeof this.value.latitude !== "undefined" &&
                    typeof this.value.longitude !== "undefined" &&
                    this.value.longitude !== null &&
                    this.value.latitude !== null &&
                    !isNaN(this.value.longitude) &&
                    !isNaN(this.value.latitude) &&
                    this.value.longitude !== 0 &&
                    this.value.latitude !== 0;
            }
            else if (typeof this.value === "string") {
                return this.value.split(',').length == 2;
            }

            return false;
        },

        /**
         * Clears coordinates, marker, and suggestions dropdown
         */
        _clearCoordinates: function () {
            this.searchTextbox.set("value", '');
            this._hideSuggestionsDropdown();

            if (this._marker) {
                this._marker.map = null;
                this._marker = null;
            }

            this._setCoordinatesValue(null);
        },

        /**
         * Wires up event handlers for help and clear icons
         */
        _wireupIcons: function () {
            const helpHandler = on(this.helpIcon, "click", function (e) {
                e.preventDefault();

                if (!this._helpDialog) {
                    this._helpDialog = new LightWeight({
                        style: "width: 540px",
                        closeIconVisible: true,
                        showButtonContainer: false,
                        onButtonClose: function () {
                            this._helpDialog.hide();
                        }.bind(this),
                        _endDrag: function () {
                        }.bind(this),
                        title: this._localized.help.dialogTitle,
                        content: this._localized.help.dialogHtml
                    });
                }

                if (this._helpDialog.open) {
                    this._helpDialog.hide();
                } else {
                    this._helpDialog.show();
                }
            }.bind(this));

            const clearHandler = on(this.clearIcon, "click", function (e) {
                this._clearCoordinates();
            }.bind(this));

            this.own(helpHandler, clearHandler);
        },

        /**
         * Logs a message to console (only on localhost for debugging)
         * @param {string} message - Message to log
         * @param {*} [data] - Optional data to include in log
         */
        log: function (message, data) {
            if (window.location.hostname !== "localhost" && !window.location.hostname.endsWith(".local")) {
                return;
            }

            const messageWithPrefix = `${this._logPrefix} ${message}`;
            if (data) {
                console.log(messageWithPrefix, data);
            } else {
                console.log(messageWithPrefix);
            }
        },

        // ==================== Google Maps Initialization ====================

        /**
         * Loads the Google Maps JavaScript API script
         * Uses global callback to notify when script is loaded
         * Prevents duplicate script tags from being created
         */
        _addGoogleMapsScript: function () {
            const callbackFunctionName = "googleMapsScriptCallback";

            // Create global editor object if one doesn't already exist, including global event for when Google Maps script has finished loading
            if (!window.googleMapsEditor) {
                window.googleMapsEditor = {};
                window.googleMapsEditor.scriptLoadedEvent = new Event("googleMapsScriptLoaded");
            }

            // Add global callback function for Google Maps to invoke when script has loaded
            if (!window[callbackFunctionName]) {
                window[callbackFunctionName] = function () {
                    this.log("Google Maps API loaded successfully");
                    document.dispatchEvent(googleMapsEditor.scriptLoadedEvent);
                }.bind(this);
            }

            const googleMapsScriptElementId = "googleMapsEditor-script";
            const scriptTagAlreadyAdded = !!document.getElementById(googleMapsScriptElementId);

            if (!scriptTagAlreadyAdded) {
                const scriptUrl = `https://maps.googleapis.com/maps/api/js?key=${this.apiKey}&loading=async&libraries=places,marker&callback=${callbackFunctionName}&v=weekly`;

                this.log("Loading Google Maps script...", scriptUrl);
                                
                const tag = document.createElement("script");
                tag.id = googleMapsScriptElementId;
                tag.src = scriptUrl;
                tag.defer = true;

                const firstScriptTag = document.getElementsByTagName("script")[0];
                firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            }
            else if (typeof google === "object" && typeof google.maps === "object") { // Script already loaded, for example when page is refreshed within the CMS UI
                window[callbackFunctionName]();
            }
        },

        /**
         * Initializes the Google Map and sets up all event listeners
         * Called after Google Maps API script has loaded
         */
        _createGoogleMapsElement: async function () {
            const initialCoordinates = new google.maps.LatLng(this.defaultCoordinates.latitude, this.defaultCoordinates.longitude);

            // Render the map, but disable interaction if property is readonly
            const mapOptions = {
                zoom: parseInt(this.defaultZoom),
                disableDefaultUI: true,
                center: initialCoordinates,
                disableDoubleClickZoom: this.readOnly,
                scrollwheel: !this.readOnly,
                draggable: !this.readOnly,
                mapId: `${this.mapId}`
            };

            this._map = new google.maps.Map(this.canvas, mapOptions);

            // Display grayscale map if property is readonly
            if (this.readOnly) {
                const grayStyle = [{
                    featureType: "all",
                    elementType: "all",
                    stylers: [{ saturation: -100 }]
                }];

                const mapType = new google.maps.StyledMapType(grayStyle, { name: "Grayscale" });
                this._map.mapTypes.set('disabled', mapType);
                this._map.setMapTypeId('disabled');
            }

            // Allow user to change coordinates unless property is readonly
            if (!this.readOnly) {
                // Update map marker when map is right-clicked
                const rightClickHandler = google.maps.event.addListener(this._map, "rightclick", function (event) {
                    this._setMapLocation(event.latLng, null, false, false);
                    this._setCoordinatesValue(event.latLng);
                }.bind(this));

                this.own({
                    remove: function () {
                        google.maps.event.removeListener(rightClickHandler);
                    }
                });

                this._setupCustomAutocomplete();
            } else {
                this.searchTextbox.set("disabled", true);
            }
        },

        // ==================== Autocomplete & Suggestions ====================

        /**
         * Creates the suggestions dropdown element if it doesn't exist
         * @private
         */
        _createSuggestionsDropdown: function () {
            if (this._suggestionsDropdown) return;

            this._suggestionsDropdown = domConstruct.create("ul", {
                class: "google-maps-suggestions-dropdown",
                style: "display: none;"
            });

            domConstruct.place(this._suggestionsDropdown, this.searchTextbox.domNode.parentNode, "last");
        },

        /**
         * Displays suggestions dropdown with list of places from autocomplete
         * @param {Array} suggestions - Array of autocomplete suggestions
         * @private
         */
        _showSuggestionsDropdown: function (suggestions) {
            if (!this._suggestionsDropdown) {
                this._createSuggestionsDropdown();
            }

            domConstruct.empty(this._suggestionsDropdown);
            this._selectedSuggestionIndex = -1;

            if (!suggestions || suggestions.length === 0) {
                this._hideSuggestionsDropdown();
                return;
            }

            suggestions.forEach((suggestion, index) => {
                const placePrediction = suggestion.placePrediction;
                const li = domConstruct.create("li", {
                    class: "suggestion-item",
                    "data-index": index,
                    innerHTML: placePrediction.text.toString()
                }, this._suggestionsDropdown);

                li.addEventListener("click", function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._selectSuggestion(index);
                }.bind(this));

                li.addEventListener("mouseenter", function () {
                    this._highlightSuggestion(index);
                }.bind(this));
            });

            domStyle.set(this._suggestionsDropdown, "display", "block");
        },

        /**
         * Hides the suggestions dropdown
         * @private
         */
        _hideSuggestionsDropdown: function () {
            if (this._suggestionsDropdown) {
                domStyle.set(this._suggestionsDropdown, "display", "none");
            }
            this._selectedSuggestionIndex = -1;
        },

        /**
         * Highlights a suggestion item by index
         * @param {number} index - Index of suggestion to highlight
         * @private
         */
        _highlightSuggestion: function (index) {
            if (!this._suggestionsDropdown) return;
            
            const items = this._suggestionsDropdown.querySelectorAll(".suggestion-item");
            items.forEach((item, i) => {
                if (i === index) {
                    domClass.add(item, "selected");
                } else {
                    domClass.remove(item, "selected");
                }
            });
            this._selectedSuggestionIndex = index;
        },

        /**
         * Handles selection of a suggestion
         * Fetches full place details and updates map and coordinates
         * @param {number} index - Index of suggestion to select
         * @private
         */
        _selectSuggestion: async function (index) {
            if (!this._suggestions || index < 0 || index >= this._suggestions.length) {
                return;
            }

            const suggestion = this._suggestions[index];
            const placePrediction = suggestion.placePrediction;

            try {
                const place = placePrediction.toPlace();
                await place.fetchFields({
                    fields: ['displayName', 'formattedAddress', 'location']
                });

                if (!place.location) {
                    return;
                }

                const lat = place.location.lat();
                const lng = place.location.lng();
                const location = new google.maps.LatLng(lat, lng);

                this._setMapLocation(location, 15, true, false);
                this._setCoordinatesValue(location);

                // Keep session token for cost optimization across multiple selections
                // Session token will be reused until user clears the search field

                this.searchTextbox.set("value", '');
                this._hideSuggestionsDropdown();

            } catch (error) {
                console.error(`${this._logPrefix} Error selecting place:`, error);
            }
        },

        /**
         * Gets or loads the Places library (cached)
         * Prevents repeated importLibrary calls
         * @returns {Promise<Object>} Object containing AutocompleteSessionToken and AutocompleteSuggestion
         * @private
         */
        _getPlacesLibrary: async function () {
            if (this._placesLibrary) {
                return this._placesLibrary;
            }

            this._placesLibrary = await google.maps.importLibrary('places');
            return this._placesLibrary;
        },

        /**
         * Fetches autocomplete suggestions from Places API
         * Uses session token for cost optimization
         * @param {string} input - User input for autocomplete search
         * @private
         */
        _fetchAutocompleteSuggestions: async function (input) {
            if (!input || input.length < 1) {
                this._hideSuggestionsDropdown();
                return;
            }

            try {
                const placesLib = await this._getPlacesLibrary();
                const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;

                if (!this._sessionToken) {
                    this._sessionToken = new AutocompleteSessionToken();
                }

                const request = {
                    input: input,
                    sessionToken: this._sessionToken
                };

                if (this._map) {
                    const center = this._map.getCenter();
                    request.origin = { lat: center.lat(), lng: center.lng() };
                }

                const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);

                this._suggestions = suggestions;
                this._showSuggestionsDropdown(suggestions);

            } catch (error) {
                console.error(`${this._logPrefix} Error fetching suggestions:`, error);
            }
        },

        /**
         * Sets up custom autocomplete functionality
         * Debounces input
         * @private
         */
        _setupCustomAutocomplete: function () {
            const typingDelay = 200;

            const inputElement = this.searchTextbox.domNode.querySelector("input") || this.searchTextbox.domNode;

            const keyupHandler = on(inputElement, "keyup", function (e) {
                if (this._typingTimer) {
                    clearTimeout(this._typingTimer);
                }
                
                const value = e.target.value;

                this._typingTimer = setTimeout(function () {
                    this._fetchAutocompleteSuggestions(value);
                }.bind(this), typingDelay);

            }.bind(this));

            const documentClickHandler = function (e) {
                if (this.searchTextbox && this.searchTextbox.domNode && 
                    !this.searchTextbox.domNode.contains(e.target) && 
                    this._suggestionsDropdown && 
                    !this._suggestionsDropdown.contains(e.target)) {
                    this._hideSuggestionsDropdown();
                }
            }.bind(this);

            document.addEventListener("click", documentClickHandler, true);

            this.own(
                keyupHandler,
                {
                    remove: function () {
                        document.removeEventListener("click", documentClickHandler, true);
                    }
                }
            );
        },

        // ==================== Coordinate & Map Management ====================

        /**
         * Updates the widget value with the given location
         * Automatically converts between object and string formats
         * @param {google.maps.LatLng} location - The location to set
         * @private
         */
        _setCoordinatesValue: function (location) {
            if (!this._started) {
                return;
            }

            let value = null;

            if (!location) {
                if (this._isComplexType()) {
                    // Set "empty" value (still an object for local block properties)
                    value = {
                        "latitude": null,
                        "longitude": null
                    };
                }
            }
            else { // Has a location
                const longitude = location.lng(),
                      latitude = location.lat();

                if (longitude === undefined || latitude === undefined) {
                    console.error(`${this._logPrefix} Unexpectedly missing longitude and/or latitude coordinate`);
                    return;
                }

                if (this._isComplexType()) {
                    value = {
                        "latitude": parseFloat(latitude),
                        "longitude": parseFloat(longitude)
                    };
                } else {
                    value = latitude + "," + longitude;
                }
            }

            this.set("value", value);
        },

        /**
         * Updates map marker position and/or map view
         * @param {google.maps.LatLng} location - Target location
         * @param {number} [zoom] - Optional zoom level (1-20)
         * @param {boolean} [center] - Optional flag to center map on location
         * @param {boolean} [skipMarker] - Optional flag to skip marker placement
         * @private
         */
        _setMapLocation: function (location, zoom, center, skipMarker) {
            if (!this._map) {
                return;
            }

            if (!skipMarker) {
                if (!this._marker) {
                    this._marker = new google.maps.marker.AdvancedMarkerElement({
                        map: this._map
                    });
                }
                this._marker.position = location;
            }

            // Center on the location (optional)
            if (center) {
                this._map.setCenter(location);
            }

            // Set map zoom level (optional)
            if (zoom) {
                this._map.setZoom(zoom);
            }
        },

        /**
         * Refreshes marker location based on current widget value
         * Called on initial load and when value changes externally
         * @private
         */
        _refreshMarkerLocation: function () {
            if (!this._map) {
                // Map not initialized;
                return;
            }

            let location;

            // If the value set is empty then clear the coordinates
            if (!this._hasCoordinates()) {
                // Set map location to default coordinates
                location = new google.maps.LatLng(this.defaultCoordinates.latitude, this.defaultCoordinates.longitude);
                this._setMapLocation(location, null, true, true);
                return;
            }

            let latitude, longitude;

            if (this._isComplexType()) {
                latitude = this.value.latitude;
                longitude = this.value.longitude;
            } else {
                const coordinates = this.value.split(",");
                latitude = parseFloat(coordinates[0]);
                longitude = parseFloat(coordinates[1]);
            }

            location = new google.maps.LatLng(latitude, longitude);
            this._setMapLocation(location, null, true, false);
        },

        /**
         * Wires up event listener for when Google Maps script loads
         * Initializes map and refreshes marker location
         * @private
         */
        _wireupGoogleMapsScriptLoaded: function () {
            const signal = on(document, "googleMapsScriptLoaded", function (e) {
                this._createGoogleMapsElement();
                this._refreshMarkerLocation();
                signal.remove();
            }.bind(this));

            this.own(signal);
        },

        // ==================== Lifecycle Methods ====================

        /**
         * Cleans up resources when widget is destroyed
         * Clears timers, removes DOM elements, and resets references
         */
        destroy: function () {
            if (this._typingTimer) {
                clearTimeout(this._typingTimer);
                this._typingTimer = null;
            }

            if (this._suggestionsDropdown) {
                domConstruct.destroy(this._suggestionsDropdown);
                this._suggestionsDropdown = null;
            }

            this._sessionToken = null;
            this._suggestions = null;
            this._placesLibrary = null;

            this.inherited(arguments);
        },

        /**
         * Called after widget creation
         * Wires up icons, loads Google Maps script, and sets up event handlers
         */
        postCreate: function () {
            this.inherited(arguments);
            this._wireupIcons();
            this._wireupGoogleMapsScriptLoaded();
            this._addGoogleMapsScript();
        },
    });  
});
