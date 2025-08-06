import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const EpisodeBundlePrice = sequelize.define('EpisodeBundlePrice', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    productId: {
      type: DataTypes.STRING,
      allowNull: true
    },
    bundle_name: {
      type: DataTypes.STRING
    },
    bundle_count: {
      type: DataTypes.INTEGER
    },
    price_points: {
      type: DataTypes.INTEGER
    },
    is_popular: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'episode_bundle_prices',
    timestamps: false
  });

  return EpisodeBundlePrice;
}; 