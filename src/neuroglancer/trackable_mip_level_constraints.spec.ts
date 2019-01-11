import {TrackableMIPLevelConstraints} from 'neuroglancer/trackable_mip_level_constraints';

describe('mipLevelConstraints', () => {
    it('invalid constraints throw an error', () => {
        expect(() => new TrackableMIPLevelConstraints(3, 1)).toThrow(new Error('Specified minMIPLevel cannot be greater than specified maxMIPLevel'));
        expect(() => new TrackableMIPLevelConstraints(1, 4, 3)).toThrow(new Error('Specified maxMIPLevel cannot be greater than the number of levels'));
        expect(() => new TrackableMIPLevelConstraints(-1, 3)).toThrow(new Error('MIPLevels must be nonnegative'));
        const trackableMIPLevelConstraints = new TrackableMIPLevelConstraints();
        expect(() => trackableMIPLevelConstraints.restoreState(4, 0)).toThrow(new Error('Specified minMIPLevel cannot be greater than specified maxMIPLevel'));
        expect(() => trackableMIPLevelConstraints.setNumberLevels(-1)).toThrow();
        trackableMIPLevelConstraints.setNumberLevels(3);
        expect(() => trackableMIPLevelConstraints.restoreState(0, 4)).toThrow(new Error('Specified maxMIPLevel cannot be greater than the number of levels'));
        expect(() => trackableMIPLevelConstraints.restoreState(-1, 4)).toThrow(new Error('MIPLevels must be nonnegative'));
        expect(() => trackableMIPLevelConstraints.setNumberLevels(4)).toThrow();
    });
    it('min/max may change if other is changed', () => {
        const trackableMIPLevelConstraints = new TrackableMIPLevelConstraints(1, 5);
        spyOn(trackableMIPLevelConstraints.minMIPLevel.changed, 'dispatch').and.callThrough();
        spyOn(trackableMIPLevelConstraints.maxMIPLevel.changed, 'dispatch').and.callThrough();
        spyOn(trackableMIPLevelConstraints.changed, 'dispatch').and.callThrough();
        trackableMIPLevelConstraints.maxMIPLevel.value = 3;
        expect(trackableMIPLevelConstraints.minMIPLevel.value).toBe(1);
        expect(trackableMIPLevelConstraints.changed.dispatch).toHaveBeenCalledTimes(1);
        trackableMIPLevelConstraints.maxMIPLevel.value = 0;
        expect(trackableMIPLevelConstraints.minMIPLevel.value).toBe(0);
        expect(trackableMIPLevelConstraints.changed.dispatch).toHaveBeenCalledTimes(2);
        trackableMIPLevelConstraints.minMIPLevel.value = 4;
        expect(trackableMIPLevelConstraints.maxMIPLevel.value).toBe(4);
        expect(trackableMIPLevelConstraints.changed.dispatch).toHaveBeenCalledTimes(3);
        trackableMIPLevelConstraints.restoreState(1, 2);
        expect(trackableMIPLevelConstraints.changed.dispatch).toHaveBeenCalledTimes(4);
        expect(trackableMIPLevelConstraints.minMIPLevel.changed.dispatch).toHaveBeenCalledTimes(3);
        expect(trackableMIPLevelConstraints.maxMIPLevel.changed.dispatch).toHaveBeenCalledTimes(4);
    });
});
