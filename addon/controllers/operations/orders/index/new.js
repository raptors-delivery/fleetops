import BaseController from '@fleetbase/fleetops-engine/controllers/base-controller';
import { inject as controller } from '@ember/controller';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action, computed, setProperties, set, get } from '@ember/object';
import { not, equal, alias } from '@ember/object/computed';
import { isArray } from '@ember/array';
import { isBlank } from '@ember/utils';
import { dasherize } from '@ember/string';
import { later, next } from '@ember/runloop';
import { task } from 'ember-concurrency-decorators';
import { OSRMv1, Control as RoutingControl } from '@fleetbase/leaflet-routing-machine';
import polyline from '@fleetbase/ember-core/utils/polyline';
import findClosestWaypoint from '@fleetbase/ember-core/utils/find-closest-waypoint';
import isNotEmpty from '@fleetbase/ember-core/utils/is-not-empty';
import getRoutingHost from '@fleetbase/ember-core/utils/get-routing-host';
import getWithDefault from '@fleetbase/ember-core/utils/get-with-default';
import isModel from '@fleetbase/ember-core/utils/is-model';

L.Bounds.prototype.intersects = function (bounds) {
    var min = this.min,
        max = this.max,
        min2 = bounds.min,
        max2 = bounds.max,
        xIntersects = max2.x >= min.x && min2.x <= max.x,
        yIntersects = max2.y >= min.y && min2.y <= max.y;

    return xIntersects && yIntersects;
};

export default class OperationsOrdersIndexNewController extends BaseController {
    @controller('operations.orders.index') ordersController;

    /**
     * Inject the `modalsManager` service
     *
     * @var {Service}
     */
    @service modalsManager;

    /**
     * Inject the `notifications` service
     *
     * @var {Service}
     */
    @service notifications;

    /**
     * Inject the `loader` service
     *
     * @var {Service}
     */
    @service loader;

    /**
     * Inject the `currentUser` service
     *
     * @var {Service}
     */
    @service currentUser;

    /**
     * Inject the `hostRouter` service
     *
     * @var {Service}
     */
    @service hostRouter;

    /**
     * Inject the `fileQueue` service
     *
     * @var {Service}
     */
    @service fileQueue;

    /**
     * Inject the `intl` service
     *
     * @var {Service}
     */
    @service intl;

    /**
     * Inject the `fetch` service
     *
     * @var {Service}
     */
    @service fetch;

    /**
     * Inject the `store` service
     *
     * @var {Service}
     */
    @service store;

    /**
     * Inject the `contextPanel` service
     *
     * @var {Service}
     */
    @service contextPanel;

    /**
     * Inject the `universe` service
     *
     * @var {Service}
     */
    @service universe;

    /**
     * Create an OrderModel instance.
     *
     * @var {OrderModel}
     */
    @tracked order = this.store.createRecord('order', { meta: [] });

    /**
     * Create an PayloadModel instance.
     *
     * @var {OrderModel}
     */
    @tracked payload = this.store.createRecord('payload');
    @tracked driversQuery = {};
    @tracked vehiclesQuery = {};
    @tracked meta = [];
    @tracked entities = [];
    @tracked waypoints = [];
    @tracked payloadCoordinates = [];
    @tracked orderConfig;
    @tracked orderConfigs = [];
    @tracked customFieldGroups = [];
    @tracked customFields = [];
    @tracked customFieldValues = {};
    @tracked serviceRates = [];
    @tracked selectedServiceRate;
    @tracked selectedServiceQuote;
    @tracked isCustomFieldsValid = true;
    @tracked isCreatingOrder = false;
    @tracked isMultipleDropoffOrder = false;
    @tracked isViewingRoutePreview = false;
    @tracked isOptimizingRoute = false;
    @tracked optimizedRouteMarkers = [];
    @tracked optimizedRoutePolyline;
    @tracked isFetchingQuotes = false;
    @tracked servicable = false;
    @tracked scheduledDate;
    @tracked scheduledTime;
    @tracked leafletRoute;
    @tracked leafletOptimizedRoute;
    @tracked currentLeafletRoute;
    @tracked leafletLayers = [];
    @tracked routeProfile = 'driving';
    @tracked routeProfileOptions = ['driving', 'bycicle', 'walking'];
    @tracked podOptions = ['scan', 'signature', 'photo'];
    @tracked isCsvImportedOrder = false;
    @tracked routePreviewArray = [];
    @tracked previewRouteControl;
    @tracked isSubscriptionValid = true;
    @tracked isUsingIntegratedVendor = false;
    @tracked integratedVendorServiceType;
    @tracked invalidReason;
    @tracked metadataButtons = [
        {
            type: 'default',
            text: 'Edit metadata',
            icon: 'edit',
            onClick: this.editMetaData,
        },
    ];
    @tracked uploadQueue = [];
    acceptedFileTypes = [
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/pdf',
        'application/x-pdf',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'video/x-msvideo',
        'video/x-flv',
        'video/x-ms-wmv',
        'audio/mpeg',
        'video/x-msvideo',
        'application/zip',
        'application/x-tar',
    ];

    get renderableComponents() {
        const renderableComponents = this.universe.getRenderableComponentsFromRegistry('fleet-ops:template:operations:orders:new');
        return renderableComponents;
    }

    get renderableEntityInputComponents() {
        const renderableComponents = this.universe.getRenderableComponentsFromRegistry('fleet-ops:template:operations:orders:new:entities-input');
        return renderableComponents;
    }

    @not('isServicable') isNotServicable;
    @alias('currentUser.latitude') userLatitude;
    @alias('currentUser.longitude') userLongitude;
    @alias('ordersController.leafletMap') leafletMap;
    @equal('isCsvImportedOrder', false) isNotCsvImportedOrder;

    @computed('isCustomFieldsValid', 'entities.length', 'isMultipleDropoffOrder', 'isFetchingQuotes', 'isSubscriptionValid', 'order.type', 'payload.{dropoff,pickup}', 'waypoints.length')
    get isValid() {
        const { isMultipleDropoffOrder, isSubscriptionValid, isFetchingQuotes } = this;
        const isOrderTypeSet = isNotEmpty(this.order?.type);
        const isWaypointsSet = this.waypoints?.length > 1;
        const isPickupSet = isNotEmpty(this.payload?.pickup);
        const isDropoffSet = isNotEmpty(this.payload?.dropoff);
        // const isPayloadSet = this.entities?.length > 0;

        if (isFetchingQuotes) {
            return false;
        }

        if (!isSubscriptionValid) {
            return false;
        }

        if (isMultipleDropoffOrder) {
            return isOrderTypeSet && isWaypointsSet;
        }

        return isOrderTypeSet && isPickupSet && isDropoffSet && this.isCustomFieldsValid;
    }

    updatePayloadCoordinates() {
        let waypoints = [];
        let coordinates = [];

        waypoints.pushObjects([this.payload.pickup, ...this.waypoints.map((waypoint) => waypoint.place), this.payload.dropoff]);
        waypoints.forEach((place) => {
            if (place && place.get('longitude') && place.get('latitude')) {
                if (place.hasInvalidCoordinates) {
                    return;
                }

                coordinates.pushObject([place.get('longitude'), place.get('latitude')]);
            }
        });

        this.payloadCoordinates = coordinates;
    }

    @computed('payloadCoordinates.length', 'waypoints.[]') get isServicable() {
        return this.payloadCoordinates.length >= 2;
    }

    @computed('routePreviewArray.[]') get routePreviewCoordinates() {
        // return this.routePreviewArray.filter((place) => place.get('hasValidCoordinates')).map((place) => place.get('latlng'));
        return (
            this.routePreviewArray
                // .filter((place) => place.get('hasValidCoordinates'))
                .map((place) => place.get('latlng'))
        );
    }

    @computed('entities.[]', 'waypoints.[]') get entitiesByImportId() {
        const groups = [];

        // create groups
        this.waypoints.forEach((waypoint) => {
            const importId = waypoint.place._import_id ?? null;

            if (importId) {
                const entities = this.entities.filter((entity) => entity._import_id === importId);
                const group = {
                    importId,
                    waypoint,
                    entities,
                };

                groups.pushObject(group);
            }
        });

        return groups;
    }

    checkIfCustomFieldsValid() {
        this.isCustomFieldsValid = this.customFields.every((customField) => {
            if (!customField.required) {
                return true;
            }
            const customFieldValue = this.customFieldValues[customField.id];
            return customFieldValue && !isBlank(customFieldValue.value);
        });
    }

    @action createOrder() {
        if (!this.isValid) {
            return;
        }

        this.previewRoute(false);
        this.loader.showLoader('body', { loadingMessage: 'Creating Order...' });

        const { order, groupedMetaFields, payload, entities, waypoints } = this;
        const route = this.leafletOptimizedRoute ? this.getOptimizedRoute() : this.getRoute();

        // set service quote if applicable
        if (this.selectedServiceQuote) {
            order.service_quote_uuid = this.selectedServiceQuote;
        }

        try {
            order.serializeMeta().serializeMetaFromGroupedFields(groupedMetaFields).setPayload(payload).setRoute(route).get('payload').setWaypoints(waypoints).setEntities(entities);
        } catch (error) {
            this.notifications.serverError(error);
            this.loader.removeLoader();
            return;
        }

        // valiadate custom field inputs
        for (let i = 0; i < this.customFields.length; i++) {
            const customField = this.customFields[i];
            if (customField.required) {
                const customFieldValue = this.customFieldValues[customField.id];
                if (!customFieldValue || isBlank(customFieldValue.value)) {
                    this.loader.removeLoader();
                    return this.notifications.error(this.intl.t('fleet-ops.operations.orders.index.new.input-field-required', { inputFieldName: customField.label }));
                }
            }
        }

        // create custom field values
        for (let customFieldId in this.customFieldValues) {
            const { value, value_type } = this.customFieldValues[customFieldId];
            const customFieldValue = this.store.createRecord('custom-field-value', {
                custom_field_uuid: customFieldId,
                value,
                value_type,
            });
            this.order.custom_field_values.push(customFieldValue);
        }

        // send event that fleetops is `creating` an order
        this.universe.trigger('fleet-ops.order.creating', order);
        this.isCreatingOrder = true;

        try {
            return order
                .save()
                .then((order) => {
                    // trigger event that fleet-ops created an order
                    this.universe.trigger('fleet-ops.order.created', order);

                    // transition to order view
                    return this.hostRouter.transitionTo(`console.fleet-ops.operations.orders.index.view`, order).then(() => {
                        this.notifications.success(this.intl.t('fleet-ops.operations.orders.index.new.success-message', { orderId: order.public_id }));
                        this.loader.removeLoader();
                        this.resetForm();
                        later(
                            this,
                            () => {
                                this.hostRouter.refresh();
                            },
                            100
                        );
                    });
                })
                .catch((error) => {
                    this.isCreatingOrder = false;
                    this.notifications.serverError(error);
                    this.loader.removeLoader();
                });
        } catch (error) {
            this.notifications.error(error.message);
            this.loader.removeLoader();
        }
    }

    @action importOrder() {
        const checkQueue = () => {
            const uploadQueue = this.modalsManager.getOption('uploadQueue');

            if (uploadQueue.length) {
                this.modalsManager.setOption('acceptButtonDisabled', false);
            } else {
                this.modalsManager.setOption('acceptButtonDisabled', true);
            }
        };

        this.modalsManager.show('modals/order-import', {
            title: 'Import order(s) with spreadsheets',
            acceptButtonText: 'Start Upload',
            acceptButtonScheme: 'magic',
            acceptButtonIcon: 'upload',
            acceptButtonDisabled: true,
            isProcessing: false,
            uploadQueue: [],
            fileQueueColumns: [
                { name: 'Type', valuePath: 'extension', key: 'type' },
                { name: 'File Name', valuePath: 'name', key: 'fileName' },
                { name: 'File Size', valuePath: 'size', key: 'fileSize' },
                { name: 'Upload Date', valuePath: 'file.lastModifiedDate', key: 'uploadDate' },
                { name: '', valuePath: '', key: 'delete' },
            ],
            acceptedFileTypes: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'],
            queueFile: (file) => {
                const uploadQueue = this.modalsManager.getOption('uploadQueue');

                uploadQueue.pushObject(file);
                checkQueue();
            },
            removeFile: (file) => {
                const { queue } = file;
                const uploadQueue = this.modalsManager.getOption('uploadQueue');

                uploadQueue.removeObject(file);
                queue.remove(file);
                checkQueue();
            },
            confirm: async (modal) => {
                const uploadQueue = this.modalsManager.getOption('uploadQueue');
                const uploadedFiles = [];
                const uploadTask = (file) => {
                    return new Promise((resolve) => {
                        this.fetch.uploadFile.perform(
                            file,
                            {
                                path: `uploads/fleet-ops/order-imports/${this.currentUser.companyId}`,
                                type: `order_import`,
                            },
                            (uploadedFile) => {
                                uploadedFiles.pushObject(uploadedFile);

                                resolve(uploadedFile);
                            }
                        );
                    });
                };

                if (!uploadQueue.length) {
                    return this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.warning-message'));
                }

                modal.startLoading();
                modal.setOption('acceptButtonText', 'Uploading...');

                for (let i = 0; i < uploadQueue.length; i++) {
                    const file = uploadQueue.objectAt(i);

                    await uploadTask(file);
                }

                this.modalsManager.setOption('acceptButtonText', 'Processing...');
                this.modalsManager.setOption('isProcessing', true);

                const files = uploadedFiles.map((file) => file.id);
                let results;

                try {
                    results = await this.fetch.post('orders/process-imports', { files });
                } catch (error) {
                    return this.notifications.serverError(error);
                }

                const places = get(results, 'places');
                const entities = get(results, 'entities');

                if (isArray(places)) {
                    this.isMultipleDropoffOrder = true;
                    this.waypoints = places.map((_place) => {
                        const place = this.store.createRecord('place', _place);
                        return this.store.createRecord('waypoint', { place });
                    });
                }

                if (isArray(entities)) {
                    this.entities = entities.map((entity) => {
                        return this.store.createRecord('entity', entity);
                    });
                }

                this.notifications.success(this.intl.t('fleet-ops.operations.orders.index.new.import-success'));
                this.isCsvImportedOrder = true;
                this.previewDraftOrderRoute(this.payload, this.waypoints, this.isMultipleDropoffOrder);
                modal.done();
            },
            decline: (modal) => {
                this.modalsManager.setOption('uploadQueue', []);
                modal.done();
            },
        });
    }

    @action async toggleAdhoc(on) {
        const defaultDistanceInMeters = 5000;

        if (on) {
            const company = this.store.peekRecord('company', this.currentUser.companyId);
            this.order.adhoc_distance = getWithDefault(company, 'options.fleetops.adhoc_distance', defaultDistanceInMeters);
        } else {
            this.order.adhoc_distance = defaultDistanceInMeters;
        }

        this.order.adhoc = on;
    }

    @action async toggleProofOfDelivery(on) {
        this.order.pod_required = on;

        if (on) {
            this.order.pod_method = 'scan';
        } else {
            this.order.pod_method = null;
        }
    }

    @action async checkServiceRates(shouldCheck) {
        this.servicable = shouldCheck;
        const params = {
            coordinates: this.getCoordinatesFromPayload().join(';'),
        };
        let serviceRates = [];

        if (this.isUsingIntegratedVendor) {
            params.facilitator = this.order.facilitator.public_id;
        }

        // filter by order config type
        if (this.orderConfig) {
            params.service_type = this.orderConfig.key;
        }

        if (shouldCheck) {
            try {
                serviceRates = await this.fetch.get(`service-rates/for-route`, params);

                serviceRates.unshiftObject({
                    service_name: 'Quote from all Service Rates',
                    id: 'all',
                });
            } catch (error) {
                this.notifications.serverError(error);
            }

            this.serviceRates = serviceRates;
        }
    }

    @action createPlace() {
        const place = this.store.createRecord('place');
        this.contextPanel.focus(place, 'editing', {
            onAfterSave: () => {
                this.contextPanel.clear();
            },
        });
    }

    @action editPlace(place) {
        this.contextPanel.focus(place, 'editing', {
            onAfterSave: () => {
                this.contextPanel.clear();
            },
        });
    }

    @action async getQuotes(service) {
        this.isFetchingQuotes = true;

        let payload = this.payload.serialize();
        let route = this.getRoute();
        let distance = get(route, 'details.summary.totalDistance');
        let time = get(route, 'details.summary.totalTime');
        let service_type = this.order.type;
        let scheduled_at = this.order.scheduled_at;
        let facilitator = this.order.facilitator?.get('public_id');
        let is_route_optimized = this.order.get('is_route_optimized');
        let { waypoints, entities } = this;
        let places = [];

        if (this.payloadCoordinates?.length < 2) {
            this.isFetchingQuotes = false;
            return;
        }

        if (this.isUsingIntegratedVendor && this.integratedVendorServiceType) {
            service_type = this.integratedVendorServiceType;
        }

        // get place instances from WaypointModel
        for (let i = 0; i < waypoints.length; i++) {
            let place = await waypoints[i].place;

            places.pushObject(place);
        }

        setProperties(payload, { waypoints: places, entities });

        if (!payload.type && this.order.type) {
            setProperties(payload, { type: this.order.type });
        }

        this.fetch
            .post('service-quotes/preliminary', {
                payload: this._getSerializedPayload(payload),
                distance,
                time,
                service,
                service_type,
                facilitator,
                scheduled_at,
                is_route_optimized,
            })
            .then((serviceQuotes) => {
                set(this, 'serviceQuotes', isArray(serviceQuotes) ? serviceQuotes : []);

                if (this.serviceQuotes.length && this.isUsingIntegratedVendor) {
                    set(this, 'selectedServiceQuote', this.serviceQuotes.firstObject?.uuid);
                }
            })
            .catch(() => {
                this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.service-warning'));
            })
            .finally(() => {
                this.isFetchingQuotes = false;
            });
    }

    _getSerializedPayload(payload) {
        const serialized = {
            pickup: this._seriailizeModel(payload.pickup),
            dropoff: this._seriailizeModel(payload.dropoff),
            entitities: this._serializeArray(payload.entities),
            waypoints: this._serializeArray(payload.waypoints),
        };

        return serialized;
    }

    _seriailizeModel(model) {
        if (isModel(model)) {
            if (typeof model.toJSON === 'function') {
                return model.toJSON();
            }

            if (typeof model.serialize === 'function') {
                return model.serialize();
            }
        }

        return model;
    }

    _serializeArray(array) {
        return isArray(array) ? array.map((item) => this._seriailizeModel(item)) : array;
    }

    @action scheduleOrder(dateInstance) {
        this.order.scheduled_at = dateInstance;
    }

    @action setupInterface() {
        if (this.leafletMap && this.leafletMap.liveMap) {
            this.leafletMap.liveMap.hideAll();

            // track all layers added from this view
            this.leafletMap.on('layeradd', ({ layer }) => {
                // disable dragging of layer
                if (layer.dragging && typeof layer.dragging.disable === 'function') {
                    layer.dragging.disable();
                }

                next(this, function () {
                    if (isArray(this.leafletLayers) && !this.leafletLayers.includes(layer)) {
                        this.leafletLayers.pushObject(layer);
                    }
                });
            });
        } else {
            // setup interface when livemap is ready
            this.universe.on('fleet-ops.live-map.ready', () => {
                this.setupInterface();
            });
        }

        // switch to map mode
        this.ordersController.setLayoutMode('map');
    }

    @action resetInterface() {
        if (this.leafletMap && this.leafletMap.liveMap) {
            this.leafletMap.liveMap.show(['drivers', 'vehicles', 'routes']);
        }
    }

    @action getRoute() {
        const details = this.leafletRoute;
        const route = this.store.createRecord('route', { details });

        return route;
    }

    @action getOptimizedRoute() {
        const details = this.leafletOptimizedRoute;
        const route = this.store.createRecord('route', { details });

        return route;
    }

    @action setOptimizedRoute(route, trip, waypoints) {
        let summary = { totalDistance: trip.distance, totalTime: trip.duration };
        let payload = {
            optimized: true,
            coordinates: route,
            waypoints,
            trip,
            summary,
        };

        this.leafletOptimizedRoute = payload;
    }

    @action removeRoutingControlPreview() {
        const leafletMap = this.leafletMap;
        const previewRouteControl = this.previewRouteControl;

        let removed = false;

        if (leafletMap && previewRouteControl instanceof RoutingControl) {
            try {
                previewRouteControl.remove();
                removed = true;
            } catch (e) {
                // silent
            }

            if (!removed) {
                try {
                    leafletMap.removeControl(previewRouteControl);
                } catch (e) {
                    // silent
                }
            }
        }

        if (!removed) {
            this.forceRemoveRoutePreview();
        }
    }

    @action forceRemoveRoutePreview() {
        const { leafletMap } = this;

        leafletMap.eachLayer((layer) => {
            if (layer instanceof L.Polyline || layer instanceof L.Marker) {
                try {
                    layer.remove();
                } catch (error) {
                    // silent error just continue with order processing if any
                }
            }
        });
    }

    @action removePreviewRouteLayers() {
        const { currentLeafletRoute, leafletMap } = this;

        if (currentLeafletRoute) {
            // target is the route, and waypoints is the markers
            const { target, waypoints } = currentLeafletRoute;

            leafletMap.removeLayer(target);
            waypoints?.forEach((waypoint) => {
                try {
                    leafletMap.removeLayer(waypoint);
                } catch (error) {
                    // silent error just continue with order processing if any
                }
            });
        }
    }

    @action clearLayers() {
        if (this.leafletMap) {
            try {
                this.leafletMap.eachLayer((layer) => {
                    if (isArray(this.leafletLayers) && this.leafletLayers.includes(layer)) {
                        this.leafletMap.removeLayer(layer);
                    }
                });
            } catch (error) {
                // fallback method with tracked layers
                if (isArray(this.leafletLayers)) {
                    this.leafletLayers.forEach((layer) => {
                        try {
                            this.leafletMap.removeLayer(layer);
                        } catch (error) {
                            // silent error just continue with order processing if any
                        }
                    });
                }
            }
        }
    }

    @action clearAllLayers() {
        if (this.leafletMap) {
            try {
                this.leafletMap.eachLayer((layer) => {
                    this.leafletMap.removeLayer(layer);
                });
            } catch (error) {
                // fallback method with tracked layers
                if (isArray(this.leafletLayers)) {
                    this.leafletLayers.forEach((layer) => {
                        try {
                            this.leafletMap.removeLayer(layer);
                        } catch (error) {
                            // silent error just continue with order processing if any
                        }
                    });
                }
            }
        }
    }

    @action createPlaceArrayFromPayload(payload, waypoints, isMultipleDropoffOrder = false) {
        const routePreviewArray = [];

        if (isMultipleDropoffOrder) {
            for (let i = 0; i < waypoints.length; i++) {
                if (waypoints[i].place) {
                    routePreviewArray.pushObject(waypoints[i].place);
                }
            }
        } else {
            if (payload.pickup) {
                routePreviewArray.pushObject(payload.pickup);
            }

            if (payload.dropoff) {
                routePreviewArray.pushObject(payload.dropoff);
            }
        }

        return routePreviewArray;
    }

    @action createCoordinatesFromRoutePlaceArray(array) {
        return array.filter((place) => place.get('hasValidCoordinates')).map((place) => place.get('latlng'));
    }

    @action previewDraftOrderRoute(payload, waypoints, isMultipleDropoffOrder = false) {
        const leafletMap = this.leafletMap;

        // if existing route preview on the map - remove it
        this.removeRoutingControlPreview();
        this.removeOptimizedRoute();
        this.clearLayers();

        if (!this.isRoutePreviewAnimationActive) {
            this.previewRoute(true);
        }

        this.isViewingRoutePreview = true;
        this.routePreviewArray = this.createPlaceArrayFromPayload(payload, waypoints, isMultipleDropoffOrder);

        const canPreviewRoute = this.routePreviewArray.length > 0;

        if (canPreviewRoute) {
            const routingHost = getRoutingHost(payload, waypoints);
            const router = new OSRMv1({
                serviceUrl: `${routingHost}/route/v1`,
                profile: 'driving',
            });

            this.previewRouteControl = new RoutingControl({
                waypoints: this.routePreviewCoordinates,
                alternativeClassName: 'hidden',
                addWaypoints: false,
                markerOptions: {
                    icon: L.icon({
                        iconUrl: '/assets/images/marker-icon.png',
                        iconRetinaUrl: '/assets/images/marker-icon-2x.png',
                        shadowUrl: '/assets/images/marker-shadow.png',
                        iconSize: [25, 41],
                        iconAnchor: [12, 41],
                    }),
                },
                router,
            }).addTo(leafletMap);

            this.previewRouteControl.on('routesfound', (event) => {
                const { routes } = event;
                const leafletRoute = routes.firstObject;
                this.currentLeafletRoute = event;

                this.setProperties({ leafletRoute });
            });

            if (this.routePreviewCoordinates.length === 1) {
                leafletMap.flyTo(this.routePreviewCoordinates[0], 18);
                leafletMap.once('moveend', function () {
                    leafletMap.panBy([200, 0]);
                });
            } else {
                leafletMap.flyToBounds(this.routePreviewCoordinates, {
                    paddingBottomRight: [300, 0],
                    maxZoom: this.routePreviewCoordinates.length === 2 ? 15 : 14,
                    animate: true,
                });
                leafletMap.once('moveend', function () {
                    leafletMap.panBy([150, 0]);
                });
            }
        } else {
            this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.no-route-warning'));
        }
    }

    @action previewRoute(isViewingRoutePreview) {
        this.isViewingRoutePreview = isViewingRoutePreview;
        this.isRoutePreviewAnimationActive = isViewingRoutePreview;

        if (isViewingRoutePreview === true) {
            this.previewDraftOrderRoute(this.payload, this.waypoints, this.isMultipleDropoffOrder);
        }

        if (isViewingRoutePreview === false) {
            this.removeRoutingControlPreview();
            this.removeOptimizedRoute();
            this.removePreviewRouteLayers();
            this.clearLayers();
        }
    }

    @action async optimizeRoute() {
        this.isOptimizingRoute = true;

        const leafletMap = this.leafletMap;
        const coordinates = this.getCoordinatesFromPayload();
        const routingHost = getRoutingHost(this.payload, this.waypoints);

        const response = await this.fetch.routing(coordinates, { source: 'any', destination: 'any', annotations: true }, { host: routingHost }).catch(() => {
            this.notifications.error(this.intl.t('fleet-ops.operations.orders.index.new.route-error'));
            this.isOptimizingRoute = false;
        });

        this.isOptimizingRoute = false;

        if (response && response.code === 'Ok') {
            // remove current route display
            this.removeRoutingControlPreview();
            this.removeOptimizedRoute(leafletMap);

            let trip = response.trips.firstObject;
            let route = polyline.decode(trip.geometry);
            let sortedWaypoints = [];
            let optimizedRouteMarkers = [];

            if (response.waypoints && isArray(response.waypoints)) {
                const responseWaypoints = response.waypoints.sortBy('waypoint_index');

                this.setOptimizedRoute(route, trip, responseWaypoints);

                for (let i = 0; i < responseWaypoints.length; i++) {
                    const optimizedWaypoint = responseWaypoints.objectAt(i);
                    const optimizedWaypointLongitude = optimizedWaypoint.location.firstObject;
                    const optimizedWaypointLatitude = optimizedWaypoint.location.lastObject;
                    const waypointModel = findClosestWaypoint(optimizedWaypointLatitude, optimizedWaypointLongitude, this.waypoints);
                    // eslint-disable-next-line no-undef
                    // const optimizedWaypointMarker = new L.Marker(optimizedWaypoint.location.reverse()).addTo(leafletMap);
                    const [longitude, latitude] = getWithDefault(optimizedWaypoint.location, 'coordiantes', [0, 0]);
                    const optimizedWaypointMarker = new L.Marker([latitude, longitude]).addTo(leafletMap);

                    sortedWaypoints.pushObject(waypointModel);
                    optimizedRouteMarkers.pushObject(optimizedWaypointMarker);
                }

                this.waypoints = sortedWaypoints;
                this.optimizedRouteMarkers = optimizedRouteMarkers;
            }

            // set order as route optimized
            this.order.set('is_route_optimized', true);

            // refetch quotes
            if (this.isUsingIntegratedVendor) {
                this.getQuotes();
            }

            // eslint-disable-next-line no-undef
            let optimizedRoute = (this.optimizedRoutePolyline = new L.Polyline(route, { color: 'red' }).addTo(leafletMap));
            // leafletMap.addLayer(optimizedRoute);
            leafletMap.flyToBounds(optimizedRoute.getBounds(), {
                paddingBottomRight: [0, 600],
                animate: true,
                maxZoom: 13,
            });
        } else {
            this.notifications.error(this.intl.t('fleet-ops.operations.orders.index.new.route-error'));
            this.isOptimizingRoute = false;
        }
    }

    @action removeOptimizedRoute(_leafletMap = null) {
        this.leafletOptimizedRoute = undefined;

        const leafletMap = _leafletMap || this.leafletMap;

        if (!leafletMap) {
            return;
        }

        if (this.optimizedRoutePolyline) {
            leafletMap.removeLayer(this.optimizedRoutePolyline);
        }

        for (let i = 0; i < this.optimizedRouteMarkers.length; i++) {
            let marker = this.optimizedRouteMarkers.objectAt(i);

            leafletMap.removeLayer(marker);
        }
    }

    @action getCoordinatesFromPayload() {
        this.notifyPropertyChange('payloadCoordinates');

        return this.payloadCoordinates;
    }

    @action toggleMultiDropOrder(isMultipleDropoffOrder) {
        this.isMultipleDropoffOrder = isMultipleDropoffOrder;

        const { pickup, dropoff } = this.payload;

        if (isMultipleDropoffOrder) {
            if (pickup) {
                this.addWaypoint({ place: pickup, customer: this.order.customer });

                if (dropoff) {
                    this.addWaypoint({ place: dropoff, customer: this.order.customer });
                }

                // clear pickup and dropoff
                this.payload.setProperties({ pickup: null, dropoff: null });
            } else {
                this.addWaypoint({ customer: this.order.customer });
            }
        } else {
            const pickup = get(this.waypoints, '0.place');
            const dropoff = get(this.waypoints, '1.place');

            if (pickup) {
                this.setPayloadPlace('pickup', pickup);
            }

            if (dropoff) {
                this.setPayloadPlace('dropoff', dropoff);
            }

            this.clearWaypoints();
        }
    }

    @action resetForm() {
        const order = this.store.createRecord('order', { meta: [] });
        const payload = this.store.createRecord('payload');
        const driversQuery = {};
        const meta = [];
        const entities = [];
        const waypoints = [];
        const orderConfigs = [];
        const orderConfig = undefined;
        const isCreatingOrder = false;
        const isMultipleDropoffOrder = false;
        const leafletRoute = undefined;
        const serviceRates = [];
        const selectedServiceRate = undefined;
        const selectedServiceQuote = undefined;
        const servicable = false;

        this.removeRoutingControlPreview();
        this.removeOptimizedRoute();
        this.setProperties({
            order,
            payload,
            driversQuery,
            meta,
            entities,
            waypoints,
            orderConfigs,
            orderConfig,
            isCreatingOrder,
            isMultipleDropoffOrder,
            leafletRoute,
            serviceRates,
            selectedServiceQuote,
            selectedServiceRate,
            servicable,
        });
        this.resetInterface();
    }

    @action setConfig(event) {
        const orderConfigId = event.target.value;
        if (!orderConfigId) {
            return;
        }

        const orderConfig = this.store.peekRecord('order-config', orderConfigId);
        this.orderConfig = orderConfig;
        this.order.set('order_config_uuid', orderConfig.id);
        this.order.set('type', orderConfig.key);

        // load custom fields
        this.loadCustomFields.perform(orderConfig);
    }

    /**
     * A task method to load custom fields from the store and group them.
     * @task
     */
    @task *loadCustomFields(orderConfig) {
        this.customFieldGroups = yield this.store.query('category', { owner_uuid: orderConfig.id, for: 'custom_field_group' });
        this.customFields = yield this.store.query('custom-field', { subject_uuid: orderConfig.id });
        this.groupCustomFields();
        this.checkIfCustomFieldsValid();
    }

    /**
     * Organizes custom fields into their respective groups.
     */
    groupCustomFields() {
        for (let i = 0; i < this.customFieldGroups.length; i++) {
            const group = this.customFieldGroups[i];
            group.set(
                'customFields',
                this.customFields.filter((customField) => {
                    return customField.category_uuid === group.id;
                })
            );
        }
    }

    @action setCustomFieldValue(value, customField) {
        this.customFieldValues = {
            ...this.customFieldValues,
            [customField.id]: {
                value,
                value_type: this._getCustomFieldValueType(customField),
            },
        };
        this.checkIfCustomFieldsValid();
    }

    _getCustomFieldValueType(customField) {
        if (customField.type === 'file-upload') {
            return 'file';
        }

        if (customField.type === 'date-time-input') {
            return 'date';
        }

        if (customField.type === 'model-select') {
            return 'model';
        }

        return 'text';
    }

    @action setOrderFacilitator(model) {
        this.order.set('facilitator', model);
        // this.order.set('facilitator_type', `fleet-ops:${model.facilitator_type}`);
        this.order.set('driver', null);

        this.isUsingIntegratedVendor = model.isIntegratedVendor;
        this.servicable = model.isIntegratedVendor;

        if (model.service_types?.length) {
            this.integratedVendorServiceType = model.service_types.firstObject.key;
        }

        if (model.isIntegratedVendor) {
            this.getQuotes();
        }

        if (model) {
            this.driversQuery = { facilitator: model.id };
        }
    }

    @action setOrderCustomer(model) {
        this.order.set('customer', model);
    }

    @action setWaypointCustomer(waypoint, model) {
        waypoint.set('customer', model);
        waypoint.set('customer_type', `fleet-ops:${model.customer_type}`);
    }

    @action selectIntegratedServiceType(key) {
        this.integratedVendorServiceType = key;

        if (this.isUsingIntegratedVendor) {
            this.getQuotes();
        }
    }

    @action async selectDriver(driver) {
        this.order.set('driver_assigned', driver);
        if (driver && driver.vehicle) {
            const vehicle = await driver.vehicle;
            this.order.set('vehicle_assigned', vehicle);
        }
    }

    @action addCustomField() {
        let label, value;

        this.modalsManager.show('modals/meta-field-form', {
            title: this.intl.t('fleet-ops.operations.orders.index.new.custom-field-title'),
            acceptButtonIcon: 'check',
            acceptButtonIconPrefix: 'fas',
            acceptButtonText: 'Done',
            declineButtonIcon: 'times',
            declineButtonIconPrefix: 'fas',
            label,
            value,
            confirm: (modal) => {
                const label = modal.getOption('label');
                const value = modal.getOption('value');

                if (!label) {
                    return this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.label-warning'));
                }

                if (!value) {
                    return this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.value-warning'));
                }

                modal.startLoading();

                this.order.meta.pushObject({
                    key: dasherize(label),
                    label,
                    value,
                });

                modal.done();
            },
        });
    }

    @action editCustomField(index) {
        const metaField = this.order.meta.objectAt(index);
        const { label, value } = metaField;

        this.modalsManager.show('modals/meta-field-form', {
            title: this.intl.t('fleet-ops.operations.orders.index.new.edit-field-title'),
            acceptButtonIcon: 'save',
            acceptButtonText: 'Save Changes',
            label,
            value,
            confirm: (modal) => {
                const label = modal.getOption('label');
                const value = modal.getOption('value');

                if (!label) {
                    return this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.label-warning'));
                }

                if (!value) {
                    return this.notifications.warning(this.intl.t('fleet-ops.operations.orders.index.new.value-warning'));
                }

                modal.startLoading();

                this.order.meta.replace(index, 1, [
                    {
                        key: dasherize(label),
                        label,
                        value,
                    },
                ]);

                modal.done();
            },
        });
    }

    @action editMetaData() {
        let { meta } = this.order;

        if (!isArray(meta)) {
            meta = [];
        }

        this.modalsManager.show('modals/edit-meta-form', {
            title: this.intl.t('fleet-ops.operations.orders.index.new.edit-metadata'),
            hideDeclineButton: true,
            acceptButtonIcon: 'check',
            acceptButtonIconPrefix: 'fas',
            acceptButtonText: 'Done',
            meta,
            addMetaField: (meta) => {
                const label = 'New field';
                meta.pushObject({
                    key: dasherize(label),
                    label,
                    value: null,
                });
            },
            removeMetaField: (meta, index) => {
                meta.removeAt(index);
            },
            confirm: (modal) => {
                const meta = modal.getOption('meta');

                this.order.meta = meta;

                modal.done();
            },
        });
    }

    @action removeMeta(meta) {
        this.meta.removeObject(meta);
    }

    @action setPayloadPlace(prop, place) {
        this.payload[prop] = place;

        // this.previewRoute(true);
        this.previewDraftOrderRoute(this.payload, this.waypoints, this.isMultipleDropoffOrder);

        if (this.isUsingIntegratedVendor) {
            this.getQuotes();
        }

        this.updatePayloadCoordinates();
    }

    @action sortWaypoints({ sourceList, sourceIndex, targetList, targetIndex }) {
        if (sourceList === targetList && sourceIndex === targetIndex) {
            return;
        }

        const item = sourceList.objectAt(sourceIndex);

        sourceList.removeAt(sourceIndex);
        targetList.insertAt(targetIndex, item);

        if (this.isViewingRoutePreview) {
            this.previewDraftOrderRoute(this.payload, this.waypoints, this.isMultipleDropoffOrder);
        }
    }

    @action addWaypoint(properties = {}) {
        if (this.order.customer) {
            properties.customer = this.order.customer;
        }

        const waypoint = this.store.createRecord('waypoint', properties);
        this.waypoints.pushObject(waypoint);
        this.updatePayloadCoordinates();
    }

    @action setWaypointPlace(index, place) {
        if (!this.waypoints[index]) {
            return;
        }

        this.waypoints[index].place = place;

        if (this.waypoints.length) {
            this.previewDraftOrderRoute(this.payload, this.waypoints, this.isMultipleDropoffOrder);
        }

        if (this.isUsingIntegratedVendor) {
            this.getQuotes();
        }

        this.updatePayloadCoordinates();
    }

    @action removeWaypoint(waypoint) {
        if (this.isMultipleDropoffOrder && this.waypoints.length === 1) {
            return;
        }

        this.waypoints.removeObject(waypoint);

        if (this.waypoints.length === 1) {
            this.previewRoute(false);
        } else {
            this.previewDraftOrderRoute(this.payload, this.waypoints, this.isMultipleDropoffOrder);
        }

        this.updatePayloadCoordinates();
    }

    @action clearWaypoints() {
        this.waypoints.clear();

        if (this.isViewingRoutePreview) {
            this.previewRoute(false);
        }
    }

    @action setEntityDestionation(index, { target }) {
        const { value } = target;

        this.entities[index].destination_uuid = value;
    }

    @action addFromCustomEntity(customEntity) {
        const entity = this.store.createRecord('entity', {
            ...customEntity,
            id: undefined,
        });

        this.entities.pushObject(entity);
    }

    @action addEntities(entities = []) {
        if (isArray(entities)) {
            this.entities.pushObjects(entities);
        }
    }

    @action addEntity(importId = null) {
        const entity = this.store.createRecord('entity', {
            _import_id: typeof importId === 'string' ? importId : null,
            currency: this.currentUser?.company?.currency ?? 'EGP',
        });

        this.entities.pushObject(entity);
    }

    @action removeEntity(entity) {
        if (this.entities.length === 1) {
            return;
        }

        if (!entity.get('isNew')) {
            return entity.destroyRecord();
        }

        this.entities.removeObject(entity);
    }

    @action editEntity(entity) {
        this.modalsManager.show('modals/entity-form', {
            title: this.intl.t('fleet-ops.operations.orders.index.new.edit-item'),
            acceptButtonText: 'Save Changes',
            entity,
            uploadNewPhoto: (file) => {
                const fileUrl = URL.createObjectURL(file.file);

                if (entity.get('isNew')) {
                    const { queue } = file;

                    this.modalsManager.setOption('pendingFileUpload', file);
                    entity.set('photo_url', fileUrl);
                    queue.remove(file);
                    return;
                } else {
                    entity.set('photo_url', fileUrl);
                }

                // Indicate loading
                this.modalsManager.startLoading();

                // Perform upload
                return this.fetch.uploadFile.perform(
                    file,
                    {
                        path: `uploads/${this.currentUser.companyId}/entities/${entity.id}`,
                        subject_uuid: entity.id,
                        subject_type: 'fleet-ops:entity',
                        type: 'entity_photo',
                    },
                    (uploadedFile) => {
                        entity.setProperties({
                            photo_uuid: uploadedFile.id,
                            photo_url: uploadedFile.url,
                            photo: uploadedFile,
                        });

                        // Stop loading
                        this.modalsManager.stopLoading();
                    },
                    () => {
                        // Stop loading
                        this.modalsManager.stopLoading();
                    }
                );
            },
            confirm: async (modal) => {
                modal.startLoading();

                const pendingFileUpload = modal.getOption('pendingFileUpload');
                return entity.save().then(() => {
                    if (pendingFileUpload) {
                        return modal.invoke('uploadNewPhoto', pendingFileUpload);
                    }
                });
            },
        });
    }

    @action transitionBack() {
        return this.transitionToRoute('operations.orders.index');
    }

    @action async newFacilitator() {
        const type = await this.modalsManager.userSelectOption('Select facilitator type', ['contact', 'vendor']);

        if (type === 'vendor') {
            const vendor = this.store.createRecord('vendor', { type: 'facilitator', status: 'active' });
            return this.contextPanel.focus(vendor, 'editing', {
                onAfterSave: (vendor) => {
                    this.setOrderFacilitator(vendor);
                    this.contextPanel.clear();
                },
            });
        }

        if (type === 'contact') {
            const contact = this.store.createRecord('contact', { type: 'facilitator', status: 'active' });
            return this.contextPanel.focus(contact, 'editing', {
                onAfterSave: (contact) => {
                    this.setOrderFacilitator(contact);
                    this.contextPanel.clear();
                },
            });
        }
    }

    @action async newCustomer() {
        const type = await this.modalsManager.userSelectOption('Select customer type', ['contact', 'vendor']);

        if (type === 'vendor') {
            const vendor = this.store.createRecord('vendor', { type: 'customer', status: 'active' });
            return this.contextPanel.focus(vendor, 'editing', {
                onAfterSave: (vendor) => {
                    this.setOrderCustomer(vendor);
                    this.contextPanel.clear();
                },
            });
        }

        if (type === 'contact') {
            const contact = this.store.createRecord('contact', { type: 'customer', status: 'active' });
            return this.contextPanel.focus(contact, 'editing', {
                onAfterSave: (contact) => {
                    this.setOrderCustomer(contact);
                    this.contextPanel.clear();
                },
            });
        }
    }

    @action applyCustomMetaFields(typeKey) {
        const type = this.types.find((type) => type.key === typeKey);

        if (!type || !type.meta) {
            return;
        }

        if (isArray(type.meta.fields)) {
            for (let i = 0; i < type.meta.fields.length; i++) {
                let field = type.meta.fields[i];

                this.meta.pushObject({
                    ...field,
                    value: null,
                });
            }
        }
    }

    @action queueFile(file) {
        // since we have dropzone and upload button within dropzone validate the file state first
        // as this method can be called twice from both functions
        if (['queued', 'failed', 'timed_out', 'aborted'].indexOf(file.state) === -1) {
            return;
        }

        // Queue and upload immediatley
        this.uploadQueue.pushObject(file);
        this.fetch.uploadFile.perform(
            file,
            {
                path: 'uploads/fleet-ops/order-files',
                type: 'order_file',
            },
            (uploadedFile) => {
                this.order.files.pushObject(uploadedFile);
                this.uploadQueue.removeObject(file);
            },
            () => {
                this.uploadQueue.removeObject(file);
                // remove file from queue
                if (file.queue && typeof file.queue.remove === 'function') {
                    file.queue.remove(file);
                }
            }
        );
    }

    @action removeFile(file) {
        return file.destroyRecord();
    }
}
